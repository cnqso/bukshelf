import { RateLimiter } from './rateLimit';
import {
  errorCategory,
  fingerprint,
  isAbortError,
  logProviderEvent,
  newRequestId,
} from './telemetry';
import { estimateTokens } from './openRouter';
import type { UsageStore } from './usageStore';

export const SONIOX_MODEL = 'tts-rt-v2';
export const SONIOX_VOICE = 'Kayla';
const SONIOX_TTS_URL = 'https://tts-rt.soniox.com/tts';
const DEFAULT_MAX_TEXT_LENGTH = 5000;

const jsonError = (error: { message: string; type: string }, status: number): Response =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const primaryLanguage = (lang: string): string | null => {
  const primary = lang.trim().split(/[-_]/, 1)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
};

const secondsUntilUtcMidnight = (now: number): number => {
  const date = new Date(now);
  const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextDay - now) / 1000));
};

export interface SonioxConfig {
  apiKey?: string;
  ttsUrl?: string;
  maxTextLength?: number;
  maxConcurrent?: number;
  maxQueueSize?: number;
  requestsPerMinute?: number;
  tokensPerMinutePerUser?: number;
  tokensPerDay?: number;
}

interface SynthesisBody {
  input?: unknown;
  voice?: unknown;
  lang?: unknown;
}

/**
 * Server-managed Soniox TTS proxy (tts-rt-v2 / Kayla → MP3). Soniox reports
 * exact model token usage only in its own usage logs, never in the synthesis
 * response, so locally recorded units are always marked estimated.
 */
export class SonioxService {
  readonly #limiter: RateLimiter;
  #userMinuteWindow: { startedAt: number; estimatedTokens: number } | null = null;

  constructor(
    private readonly config: SonioxConfig,
    private readonly usage: UsageStore,
  ) {
    // Soniox defaults to three concurrent TTS streams; stay below that ceiling
    // so other uses of the same project keep headroom.
    this.#limiter = new RateLimiter({
      maxConcurrent: config.maxConcurrent ?? 2,
      maxQueueSize: config.maxQueueSize ?? 32,
      requestsPerMinute: config.requestsPerMinute ?? 90,
    });
  }

  get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  limits() {
    return {
      maxConcurrent: this.config.maxConcurrent ?? 2,
      maxQueueSize: this.config.maxQueueSize ?? 32,
      requestsPerMinute: this.config.requestsPerMinute ?? 90,
      tokensPerMinutePerUser: this.config.tokensPerMinutePerUser ?? 20_000,
      tokensPerDay: this.config.tokensPerDay ?? 500_000,
    };
  }

  snapshot(now = Date.now()) {
    const minuteValid =
      this.#userMinuteWindow !== null && now - this.#userMinuteWindow.startedAt < 60_000;
    return {
      model: SONIOX_MODEL,
      todayUnits: this.usage.dayUnits('soniox', now),
      minuteEstimatedTokens: minuteValid ? this.#userMinuteWindow!.estimatedTokens : 0,
      limits: this.limits(),
      activeRequests: this.#limiter.activeRequests,
    };
  }

  async handleSynthesizePost(request: Request, ownerId: string): Promise<Response> {
    if (!this.config.apiKey)
      return jsonError(
        { message: 'Soniox TTS is not configured', type: 'service_unavailable' },
        503,
      );

    let body: SynthesisBody;
    try {
      body = (await request.json()) as SynthesisBody;
    } catch {
      return jsonError({ message: 'Invalid JSON body', type: 'invalid_request_error' }, 400);
    }
    if (!body || typeof body !== 'object')
      return jsonError({ message: 'Invalid request body', type: 'invalid_request_error' }, 400);

    const input = body.input;
    const maxTextLength = this.config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    if (typeof input !== 'string' || input.trim().length === 0 || input.length > maxTextLength)
      return jsonError(
        {
          message: `"input" must contain between 1 and ${maxTextLength} characters`,
          type: 'invalid_request_error',
        },
        400,
      );
    if (body.voice !== SONIOX_VOICE)
      return jsonError(
        { message: `Voice must be "${SONIOX_VOICE}"`, type: 'invalid_request_error' },
        400,
      );
    const language = typeof body.lang === 'string' ? primaryLanguage(body.lang) : null;
    if (!language)
      return jsonError({ message: 'Invalid "lang" field', type: 'invalid_request_error' }, 400);

    const requestId = newRequestId();
    const characters = input.length;
    const estimatedTokens = estimateTokens(input);
    const now = Date.now();
    const logBase = {
      requestId,
      ownerId: fingerprint(ownerId),
      model: SONIOX_MODEL,
      voice: SONIOX_VOICE,
      language,
      characters,
      textFingerprint: fingerprint(input),
      estimatedTokens,
    };

    const reject = (reason: string, retryAfterSeconds: number): Response => {
      this.usage.record({
        requestId,
        provider: 'soniox',
        operation: 'tts',
        model: SONIOX_MODEL,
        ownerId,
        status: 'rejected',
        httpStatus: reason === 'cancelled' ? 499 : 429,
        inputUnits: estimatedTokens,
        unitsExact: false,
        errorCategory: reason,
      });
      logProviderEvent('warn', 'soniox_tts', 'rejected', { ...logBase, reason });
      if (reason === 'cancelled')
        return jsonError({ message: 'Soniox TTS request was cancelled', type: 'cancelled' }, 499);
      return Response.json(
        {
          error: {
            message: 'Soniox TTS usage limit reached',
            type: reason,
            retryAfterSeconds,
          },
        },
        {
          status: 429,
          headers: { 'cache-control': 'no-store', 'Retry-After': String(retryAfterSeconds) },
        },
      );
    };

    const minute = this.#minuteWindow(now);
    if (minute.estimatedTokens + estimatedTokens > (this.config.tokensPerMinutePerUser ?? 20_000))
      return reject(
        'user_token_limit',
        Math.max(1, Math.ceil((minute.startedAt + 60_000 - now) / 1000)),
      );
    if (
      this.usage.dayUnits('soniox', now) + estimatedTokens >
      (this.config.tokensPerDay ?? 500_000)
    )
      return reject('daily_token_limit', secondsUntilUtcMidnight(now));

    const grant = await this.#limiter.acquire(request.signal, now);
    if (!grant.accepted) return reject(grant.reason, grant.retryAfterSeconds);

    minute.estimatedTokens += estimatedTokens;
    const startedAt = Date.now();
    logProviderEvent('info', 'soniox_tts', 'started', {
      ...logBase,
      queueWaitMs: startedAt - now,
    });

    try {
      const upstream = await fetch(this.config.ttsUrl ?? SONIOX_TTS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey!}`,
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
        },
        body: JSON.stringify({
          model: SONIOX_MODEL,
          language,
          voice: SONIOX_VOICE,
          audio_format: 'mp3',
          text: input,
          client_reference_id: requestId,
        }),
        signal: request.signal,
      });

      if (!upstream.ok) {
        const detail = (await upstream.json().catch(() => null)) as {
          error_type?: unknown;
          error_message?: unknown;
          request_id?: unknown;
        } | null;
        const errorType =
          typeof detail?.error_type === 'string' ? detail.error_type : 'upstream_error';
        this.#record(requestId, ownerId, 'failed', upstream.status, estimatedTokens, false, {
          durationMs: Date.now() - startedAt,
          errorCategory: errorType,
        });
        logProviderEvent('warn', 'soniox_tts', 'upstream_error', {
          ...logBase,
          status: upstream.status,
          errorType,
          durationMs: Date.now() - startedAt,
        });
        return jsonError(
          {
            message:
              typeof detail?.error_message === 'string'
                ? detail.error_message
                : 'Soniox TTS request failed',
            type: errorType,
          },
          upstream.status >= 400 ? upstream.status : 502,
        );
      }

      const audio = await upstream.arrayBuffer();
      if (audio.byteLength === 0) {
        this.#record(requestId, ownerId, 'failed', 502, estimatedTokens, false, {
          durationMs: Date.now() - startedAt,
          errorCategory: 'empty_audio',
        });
        logProviderEvent('warn', 'soniox_tts', 'upstream_error', {
          ...logBase,
          status: 502,
          errorType: 'empty_audio',
          durationMs: Date.now() - startedAt,
        });
        return jsonError({ message: 'Soniox returned no audio', type: 'upstream_error' }, 502);
      }

      this.#record(requestId, ownerId, 'success', 200, estimatedTokens, false, {
        outputUnits: audio.byteLength,
        totalUnits: estimatedTokens + audio.byteLength,
        durationMs: Date.now() - startedAt,
      });
      logProviderEvent('info', 'soniox_tts', 'completed', {
        ...logBase,
        status: 200,
        audioBytes: audio.byteLength,
        durationMs: Date.now() - startedAt,
      });
      return new Response(audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(audio.byteLength),
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (error) {
      const cancelled = isAbortError(error) || request.signal.aborted;
      this.#record(requestId, ownerId, 'failed', cancelled ? 499 : 502, estimatedTokens, false, {
        durationMs: Date.now() - startedAt,
        errorCategory: cancelled ? 'timeout_or_cancelled' : errorCategory(error),
      });
      logProviderEvent(
        cancelled ? 'info' : 'error',
        'soniox_tts',
        cancelled ? 'cancelled' : 'network_error',
        {
          ...logBase,
          durationMs: Date.now() - startedAt,
        },
      );
      if (cancelled)
        return jsonError({ message: 'Soniox TTS request was cancelled', type: 'cancelled' }, 499);
      return jsonError({ message: 'Soniox TTS is unavailable', type: 'upstream_error' }, 502);
    }
  }

  #record(
    requestId: string,
    ownerId: string,
    status: 'success' | 'failed',
    httpStatus: number,
    inputUnits: number,
    unitsExact: boolean,
    extra: {
      outputUnits?: number;
      totalUnits?: number;
      durationMs?: number;
      errorCategory?: string;
    },
  ): void {
    this.usage.record({
      requestId,
      provider: 'soniox',
      operation: 'tts',
      model: SONIOX_MODEL,
      ownerId,
      status,
      httpStatus,
      inputUnits,
      unitsExact,
      outputUnits: extra.outputUnits ?? 0,
      totalUnits: extra.totalUnits,
      durationMs: extra.durationMs,
      errorCategory: extra.errorCategory,
    });
  }

  #minuteWindow(now: number): { startedAt: number; estimatedTokens: number } {
    if (!this.#userMinuteWindow || now - this.#userMinuteWindow.startedAt >= 60_000) {
      this.#userMinuteWindow = { startedAt: now, estimatedTokens: 0 };
    }
    return this.#userMinuteWindow;
  }
}

export const createSonioxConfigFromEnv = (): SonioxConfig => ({
  apiKey: process.env.SONIOX_API_KEY,
  maxConcurrent: positiveInteger(process.env.SONIOX_TTS_MAX_CONCURRENT, 2),
  maxQueueSize: positiveInteger(process.env.SONIOX_TTS_MAX_QUEUE_SIZE, 32),
  requestsPerMinute: positiveInteger(process.env.SONIOX_TTS_REQUESTS_PER_MINUTE, 90),
  tokensPerMinutePerUser: positiveInteger(
    process.env.SONIOX_TTS_TOKENS_PER_MINUTE_PER_USER,
    20_000,
  ),
  tokensPerDay: positiveInteger(process.env.SONIOX_TTS_TOKENS_PER_DAY, 500_000),
});
