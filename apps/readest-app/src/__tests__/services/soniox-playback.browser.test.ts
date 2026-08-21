import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

import { SonioxTTSClient } from '@/services/tts/SonioxTTSClient';
import type { SpeechProvider } from '@/services/tts/providers/types';

const makeToneWav = (durationSec = 0.12, sampleRate = 16_000): ArrayBuffer => {
  const sampleCount = Math.round(durationSec * sampleRate);
  const dataBytes = sampleCount * 2;
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < sampleCount; index++) {
    const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.2;
    view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
  }
  return wav;
};

const SSML = `<speak xml:lang="en">
  <mark name="0"/>First sentence.
  <mark name="1"/>Second sentence.
  <mark name="2"/>Third sentence.
</speak>`;

const clients: SonioxTTSClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
});

describe('Soniox playback in a real browser AudioContext', () => {
  test('decodes, schedules, and completes three consecutive marks', async () => {
    const provider: SpeechProvider = {
      id: 'soniox-tts',
      label: 'Soniox TTS fixture',
      fallbackVoiceId: 'Kayla',
      init: vi.fn().mockResolvedValue(true),
      getAllVoices: vi
        .fn()
        .mockResolvedValue([{ id: 'Kayla', name: 'Kayla', lang: 'en', disabled: false }]),
      synthesize: vi.fn().mockImplementation(async () => ({
        audio: makeToneWav(),
        boundaries: [],
      })),
    };
    const client = new SonioxTTSClient(undefined, undefined, { provider });
    clients.push(client);
    expect(await client.init()).toBe(true);

    const collectPlayback = async () => {
      const received = [];
      for await (const event of client.speak(SSML, new AbortController().signal)) {
        received.push(event);
      }
      return received;
    };
    let playback: ReturnType<typeof collectPlayback> | null = null;
    const start = document.createElement('button');
    start.textContent = 'Start fixture playback';
    start.addEventListener('click', () => {
      playback = collectPlayback();
    });
    document.body.append(start);
    await page.getByRole('button', { name: 'Start fixture playback' }).click();
    expect(playback).not.toBeNull();

    const events = await Promise.race([
      playback!,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Browser AudioContext playback stalled')), 5_000),
      ),
    ]);

    expect(provider.synthesize).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.code === 'boundary').map((event) => event.mark)).toEqual([
      '0',
      '1',
      '2',
    ]);
    expect(events.at(-1)?.code).toBe('end');
  });
});
