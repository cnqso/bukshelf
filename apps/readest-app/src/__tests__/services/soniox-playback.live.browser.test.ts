import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import { SonioxTTSClient } from '@/services/tts/SonioxTTSClient';
import type {
  SpeechProvider,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@/services/tts/providers/types';

const PROXY_ORIGIN = 'http://127.0.0.1:43282';
const clients: SonioxTTSClient[] = [];

const getToken = async (): Promise<string> => {
  const response = await fetch(`${PROXY_ORIGIN}/__test/session`);
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
};

const liveProvider = (token: string, requests: string[]): SpeechProvider => ({
  id: 'soniox-tts',
  label: 'Live Soniox TTS',
  fallbackVoiceId: 'Kayla',
  async init() {
    const response = await fetch(`${PROXY_ORIGIN}/api/tts/soniox`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  },
  async getAllVoices() {
    return [{ id: 'Kayla', name: 'Kayla', lang: 'en', disabled: false }];
  },
  async synthesize(
    request: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    requests.push(request.text);
    const response = await fetch(`${PROXY_ORIGIN}/api/tts/soniox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: request.text, lang: request.lang, voice: 'Kayla' }),
      signal,
    });
    if (!response.ok) throw new Error(`Live Soniox request failed (${response.status})`);
    return { audio: await response.arrayBuffer(), boundaries: [] };
  },
});

const speak = async (client: SonioxTTSClient, ssml: string) => {
  const events = [];
  for await (const event of client.speak(ssml, new AbortController().signal)) events.push(event);
  return events;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  document.body.replaceChildren();
});

describe('live Soniox playback through Bun and Chromium', () => {
  test('plays three marks and three following paragraphs without stalling', async () => {
    const requests: string[] = [];
    const client = new SonioxTTSClient(undefined, undefined, {
      provider: liveProvider(await getToken(), requests),
    });
    clients.push(client);
    expect(await client.init()).toBe(true);

    let run: Promise<unknown> | null = null;
    const start = document.createElement('button');
    start.textContent = 'Start live Soniox regression';
    start.addEventListener('click', () => {
      run = (async () => {
        const first = await speak(
          client,
          '<speak xml:lang="en"><mark name="0"/>One sentence is working. <mark name="1"/>Two sentences are still working. <mark name="2"/>Three sentences finally work in sequence.</speak>',
        );
        expect(first.filter((event) => event.code === 'boundary')).toHaveLength(3);
        expect(first.at(-1)?.code).toBe('end');

        for (let paragraph = 0; paragraph < 3; paragraph++) {
          const events = await speak(
            client,
            `<speak xml:lang="en"><mark name="${paragraph}"/>This is live paragraph ${paragraph + 1}, following the completed session.</speak>`,
          );
          expect(events.at(-1)?.code).toBe('end');
        }
      })();
    });
    document.body.append(start);
    await page.getByRole('button', { name: 'Start live Soniox regression' }).click();
    expect(run).not.toBeNull();
    await run;

    expect(requests).toHaveLength(6);
  });
});
