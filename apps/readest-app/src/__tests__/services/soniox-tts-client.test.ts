import { beforeEach, describe, expect, test, vi } from 'vitest';

import { SonioxTTSClient } from '@/services/tts/SonioxTTSClient';
import type { SpeechProvider } from '@/services/tts/providers/types';
import { WebAudioPlayer } from '@/services/tts/WebAudioPlayer';
import { FakeAudioContext } from './tts-fake-audio';

const SSML =
  '<speak xml:lang="en"><mark name="0"/>First sentence.<mark name="1"/>Second sentence.</speak>';

const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

const setup = () => {
  const context = new FakeAudioContext(1000);
  context.decodeImpl = async () => {
    const samples = new Float32Array(1000);
    samples.fill(0.25);
    return {
      sampleRate: 1000,
      length: samples.length,
      duration: 1,
      getChannelData: () => samples,
      copyToChannel: (source: Float32Array) => samples.set(source),
    };
  };
  const provider: SpeechProvider = {
    id: 'soniox-tts',
    label: 'Soniox TTS',
    fallbackVoiceId: 'Kayla',
    init: vi.fn().mockResolvedValue(true),
    getAllVoices: vi
      .fn()
      .mockResolvedValue([{ id: 'Kayla', name: 'Kayla', lang: 'en', disabled: false }]),
    synthesize: vi.fn().mockResolvedValue({ audio: new ArrayBuffer(16), boundaries: [] }),
  };
  const player = new WebAudioPlayer(() => context);
  const client = new SonioxTTSClient(undefined, undefined, { provider, player });
  return { client, context, provider };
};

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SonioxTTSClient', () => {
  test('synthesizes once per mark and completes after audible playback', async () => {
    const { client, context, provider } = setup();
    await client.init();
    const iterator = client.speak(SSML, new AbortController().signal)[Symbol.asyncIterator]();

    const firstBoundary = iterator.next();
    await flush();
    expect(await firstBoundary).toMatchObject({ value: { code: 'boundary', mark: '0' } });
    expect(provider.synthesize).toHaveBeenCalledTimes(2);

    const secondBoundary = iterator.next();
    await context.advanceTo(1.03);
    expect(await secondBoundary).toMatchObject({ value: { code: 'boundary', mark: '1' } });

    const end = iterator.next();
    await flush();
    await context.advanceTo(2.3);
    expect(await end).toMatchObject({ value: { code: 'end' } });
  });

  test('treats cancellation as a normal terminal state without retrying', async () => {
    const { client, provider } = setup();
    const controller = new AbortController();
    vi.mocked(provider.synthesize).mockImplementation(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const iterator = client.speak(SSML, controller.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await flush();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  test('preload is a no-op instead of a competing scheduler', async () => {
    const { client, provider } = setup();
    const events = [];
    for await (const event of client.speak(SSML, new AbortController().signal, true)) {
      events.push(event);
    }
    expect(events).toEqual([{ code: 'end', message: 'Preload intentionally skipped' }]);
    expect(provider.synthesize).not.toHaveBeenCalled();
  });
});
