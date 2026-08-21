import type { AppService } from '@/types/system';
import { parseSSMLMarks } from '@/utils/ssml';
import { applyEdgeFade, findSpeechBounds } from './pcm';
import { timeStretch } from './timeStretch';
import type { TTSController } from './TTSController';
import type { TTSClient, TTSCapabilities, TTSMessageEvent } from './TTSClient';
import type { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { fingerprintTTSInput, recordTTSDiagnostic } from './diagnostics';
import { SONIOX_VOICE_ID, SonioxSpeechProvider } from './providers/soniox';
import type { SpeechProvider, SpeechSynthesisRequest } from './providers/types';
import { type TTSAudioBuffer, WebAudioPlayer, type WebAudioPlayerEvent } from './WebAudioPlayer';

type SessionEvent =
  | { kind: 'chunk-start'; index: number }
  | { kind: 'session-end' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; message: string };

interface PreparedMark {
  mark: TTSMark;
  buffer: TTSAudioBuffer;
  trimStartSec: number;
  trimmedDurationSec: number;
}

interface ActiveSession {
  id: string;
  generation: number;
  queue: AsyncQueue<SessionEvent>;
  signal: AbortSignal;
  abortHandler: () => void;
  marks: PreparedMark[];
  cancelled: boolean;
}

class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    const item = this.#items.shift();
    return item === undefined
      ? new Promise((resolve) => this.#waiters.push(resolve))
      : Promise.resolve(item);
  }
}

const makeSessionId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `tts-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Deterministic, single-flight Soniox playback for Bukshelf.
 *
 * Readest's generic buffered client races controller preloads, a detached
 * scheduler and cancellation retries. This client owns exactly one scheduler
 * and one WebAudio generation. Preload calls are observable no-ops. The old
 * persistent-cache path is deliberately bypassed until playback is reliable;
 * it introduced worker timeouts and short reads before provider synthesis.
 */
export class SonioxTTSClient implements TTSClient {
  readonly name = 'soniox-tts';
  initialized = false;

  readonly #controller?: TTSController;
  readonly #provider: SpeechProvider;
  readonly #player: WebAudioPlayer;
  #active: ActiveSession | null = null;
  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #voiceId = SONIOX_VOICE_ID;
  #rate = 1;
  #pitch = 1;
  #sentenceGapSec = 0.15;

  constructor(
    controller?: TTSController,
    _appService?: AppService | null,
    dependencies?: { provider?: SpeechProvider; player?: WebAudioPlayer },
  ) {
    this.#controller = controller;
    this.#provider = dependencies?.provider ?? new SonioxSpeechProvider();
    this.#player = dependencies?.player ?? new WebAudioPlayer();
  }

  async init(): Promise<boolean> {
    const started = performance.now();
    this.#voices = await this.#provider.getAllVoices();
    this.initialized = await this.#provider.init();
    recordTTSDiagnostic({
      component: 'soniox-client',
      event: 'initialized',
      level: this.initialized ? 'info' : 'warn',
      details: { available: this.initialized, durationMs: Math.round(performance.now() - started) },
    });
    return this.initialized;
  }

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    if (preload) {
      recordTTSDiagnostic({
        component: 'soniox-client',
        event: 'preload-skipped',
        level: 'debug',
        details: { marks: marks.length },
      });
      yield { code: 'end', message: 'Preload intentionally skipped' };
      return;
    }

    this.#cancelActive('superseded');
    if (signal.aborted) return;

    const id = makeSessionId();
    const queue = new AsyncQueue<SessionEvent>();
    let active!: ActiveSession;
    const generation = this.#player.startSession((event: WebAudioPlayerEvent) => {
      if (this.#active !== active || active.cancelled) return;
      if (event.type === 'chunk-start')
        queue.push({ kind: 'chunk-start', index: event.chunkIndex });
      else if (event.type === 'session-end') queue.push({ kind: 'session-end' });
      else if (event.type === 'chunk-end') {
        recordTTSDiagnostic({
          sessionId: id,
          component: 'audio-player',
          event: 'audio-end',
          level: event.recovered ? 'warn' : 'info',
          details: { index: event.chunkIndex, watchdogRecovered: event.recovered },
        });
      } else queue.push({ kind: 'error', message: event.message });
    });
    const abortHandler = () => this.#cancel(active, 'abort-signal');
    active = {
      id,
      generation,
      queue,
      signal,
      abortHandler,
      marks: [],
      cancelled: false,
    };
    this.#active = active;
    signal.addEventListener('abort', abortHandler, { once: true });

    recordTTSDiagnostic({
      sessionId: id,
      component: 'soniox-client',
      event: 'session-start',
      level: 'info',
      details: { marks: marks.length, rate: this.#rate, voice: this.#voiceId },
    });

    try {
      await this.#player.ensureContext();
      recordTTSDiagnostic({
        sessionId: id,
        component: 'audio-player',
        event: 'context-ready',
        level: 'info',
      });
      void this.#schedule(active, marks);

      for (;;) {
        const event = await queue.next();
        if (event.kind === 'cancelled') return;
        if (event.kind === 'error') {
          recordTTSDiagnostic({
            sessionId: id,
            component: 'soniox-client',
            event: 'session-error',
            level: 'error',
            details: { message: event.message },
          });
          yield { code: 'error', message: event.message };
          return;
        }
        if (event.kind === 'chunk-start') {
          const prepared = active.marks[event.index];
          if (!prepared) continue;
          this.#speakingLang = prepared.mark.language;
          this.#controller?.dispatchSpeakMark(prepared.mark);
          this.#controller?.prepareSpeakWords([]);
          recordTTSDiagnostic({
            sessionId: id,
            component: 'audio-player',
            event: 'audio-start',
            level: 'info',
            details: {
              index: event.index,
              mark: prepared.mark.name,
              durationMs: Math.round(prepared.trimmedDurationSec * 1000),
            },
          });
          yield { code: 'boundary', mark: prepared.mark.name };
          continue;
        }
        recordTTSDiagnostic({
          sessionId: id,
          component: 'soniox-client',
          event: 'session-complete',
          level: 'info',
          details: { scheduled: active.marks.length },
        });
        yield { code: 'end', message: 'Speak finished' };
        return;
      }
    } catch (error) {
      if (signal.aborted || active.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      recordTTSDiagnostic({
        sessionId: id,
        component: 'soniox-client',
        event: 'session-error',
        level: 'error',
        details: { message },
      });
      yield { code: 'error', message };
    } finally {
      signal.removeEventListener('abort', abortHandler);
      if (this.#active === active) this.#active = null;
    }
  }

  async #schedule(active: ActiveSession, marks: TTSMark[]): Promise<void> {
    try {
      for (let index = 0; index < marks.length; index++) {
        if (!this.#isCurrent(active)) return;
        const mark = marks[index]!;
        const request: SpeechSynthesisRequest = {
          lang: mark.language,
          text: mark.text,
          voice: this.#voiceId,
          pitch: this.#pitch,
        };
        const started = performance.now();
        recordTTSDiagnostic({
          sessionId: active.id,
          component: 'soniox-provider',
          event: 'synthesis-start',
          level: 'info',
          details: {
            index,
            characters: mark.text.length,
            fingerprint: fingerprintTTSInput(mark.text),
          },
        });
        const result = await this.#provider.synthesize(request, active.signal);
        if (!this.#isCurrent(active)) return;
        recordTTSDiagnostic({
          sessionId: active.id,
          component: 'soniox-provider',
          event: 'synthesis-complete',
          level: 'info',
          details: {
            index,
            audioBytes: result.audio.byteLength,
            durationMs: Math.round(performance.now() - started),
          },
        });
        const prepared = await this.#prepare(mark, result.audio);
        if (!this.#isCurrent(active)) return;
        const ready = await this.#player.waitUntilReady(active.generation);
        if (!ready || !this.#isCurrent(active)) return;
        // Metadata must exist before scheduleChunk: the first chunk-start is synchronous.
        active.marks.push(prepared);
        this.#player.scheduleChunk(active.generation, prepared.buffer, {
          trimStartSec: prepared.trimStartSec,
          mediaScale: prepared.trimmedDurationSec / prepared.buffer.duration,
          gapSec: this.#sentenceGapSec,
        });
        recordTTSDiagnostic({
          sessionId: active.id,
          component: 'audio-player',
          event: 'audio-scheduled',
          level: 'info',
          details: { index, buffered: active.marks.length },
        });
      }
      if (this.#isCurrent(active)) this.#player.endSession(active.generation);
    } catch (error) {
      if (!this.#isCurrent(active)) return;
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      if (isAbort || active.signal.aborted) {
        this.#cancel(active, 'provider-abort');
        return;
      }
      active.queue.push({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #prepare(mark: TTSMark, audio: ArrayBuffer): Promise<PreparedMark> {
    const decoded = await this.#player.decode(audio);
    const channel = decoded.getChannelData(0);
    const bounds = findSpeechBounds(channel, decoded.sampleRate);
    const start = Math.floor(bounds.startSec * decoded.sampleRate);
    const end = Math.min(channel.length, Math.ceil(bounds.endSec * decoded.sampleRate));
    const trimmed = channel.subarray(start, end);
    const duration = trimmed.length / decoded.sampleRate;
    const samples =
      this.#rate === 1 ? trimmed : timeStretch(trimmed, decoded.sampleRate, this.#rate);
    const buffer = await this.#player.createMonoBuffer(samples, decoded.sampleRate);
    applyEdgeFade(buffer.getChannelData(0), decoded.sampleRate);
    return {
      mark,
      buffer,
      trimStartSec: start / decoded.sampleRate,
      trimmedDurationSec: duration,
    };
  }

  #isCurrent(active: ActiveSession): boolean {
    return this.#active === active && !active.cancelled && !active.signal.aborted;
  }

  #cancel(active: ActiveSession, reason: string): void {
    if (active.cancelled) return;
    active.cancelled = true;
    this.#player.abortSession();
    active.queue.push({ kind: 'cancelled', reason });
    recordTTSDiagnostic({
      sessionId: active.id,
      component: 'soniox-client',
      event: 'session-cancelled',
      level: 'info',
      details: { reason, scheduled: active.marks.length },
    });
    if (this.#active === active) this.#active = null;
  }

  #cancelActive(reason: string): void {
    if (this.#active) this.#cancel(this.#active, reason);
  }

  async pause(): Promise<boolean> {
    await this.#player.pauseContext();
    recordTTSDiagnostic({ component: 'audio-player', event: 'paused', level: 'info' });
    return true;
  }

  async resume(): Promise<boolean> {
    await this.#player.resumeContext();
    recordTTSDiagnostic({ component: 'audio-player', event: 'resumed', level: 'info' });
    return true;
  }

  async stop(): Promise<void> {
    this.#cancelActive('stop');
  }

  async shutdown(): Promise<void> {
    this.#cancelActive('shutdown');
    await this.#player.shutdown();
    await this.#provider.shutdown?.();
    this.initialized = false;
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  async setRate(rate: number): Promise<void> {
    this.#rate = rate;
  }

  async setPitch(pitch: number): Promise<void> {
    this.#pitch = pitch;
  }

  async setVoice(voice: string): Promise<void> {
    if (voice === SONIOX_VOICE_ID) this.#voiceId = voice;
  }

  setSentenceGap(seconds: number): void {
    this.#sentenceGapSec = Math.max(0, seconds);
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#voices.map((voice) => ({ ...voice, disabled: !this.initialized }));
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    return [
      {
        id: this.name,
        name: this.#provider.label,
        voices: [{ id: SONIOX_VOICE_ID, name: SONIOX_VOICE_ID, lang, disabled: !this.initialized }],
        disabled: !this.initialized,
      },
    ];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getCapabilities(): TTSCapabilities {
    return {
      wordBoundaries: false,
      mediaClock: true,
      gapControl: true,
      liveRateChange: false,
      scheduledGaps: false,
    };
  }

  getVoiceId(): string {
    return this.#voiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  getChunkPosition(): number | null {
    const active = this.#active;
    if (!active) return null;
    const position = this.#player.getPlaybackPosition(active.generation);
    if (!position) return null;
    const mark = active.marks[position.chunkIndex];
    if (!mark) return null;
    return Math.min(
      Math.max(position.mediaTimeSec - mark.trimStartSec, 0),
      mark.trimmedDurationSec,
    );
  }
}
