import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/fetch', () => ({
  fetchWithAuth: fetchWithAuthMock,
  bukshelfProviderUrl: (path: string) => `http://bukshelf.test${path}`,
}));

import { SonioxSpeechProvider } from '@/services/tts/providers/soniox';

describe('SonioxSpeechProvider', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
  });

  it('advertises Kayla and only initializes through the authenticated proxy', async () => {
    fetchWithAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'tts-rt-v2',
          voices: [{ id: 'Kayla', name: 'Kayla', language: 'en' }],
        }),
        { status: 200 },
      ),
    );
    const provider = new SonioxSpeechProvider();

    expect(await provider.init()).toBe(true);
    expect(await provider.getAllVoices()).toEqual([{ id: 'Kayla', name: 'Kayla', lang: 'en' }]);
    expect(fetchWithAuthMock).toHaveBeenCalledWith('http://bukshelf.test/api/tts/soniox', {
      method: 'GET',
    });
  });

  it('returns MP3 bytes and sentence-level timing metadata', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    fetchWithAuthMock.mockResolvedValue(new Response(audio, { status: 200 }));
    const provider = new SonioxSpeechProvider();
    const signal = new AbortController().signal;

    const result = await provider.synthesize(
      { lang: 'en-US', text: 'Hello from Kayla.', voice: 'Kayla', pitch: 1 },
      signal,
    );

    expect(new Uint8Array(result.audio)).toEqual(audio);
    expect(result.boundaries).toEqual([]);
    expect(fetchWithAuthMock).toHaveBeenCalledWith('http://bukshelf.test/api/tts/soniox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello from Kayla.', lang: 'en-US', voice: 'Kayla' }),
      signal,
    });
  });

  it('rejects an empty audio response as permanent for that sentence', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(new ArrayBuffer(0), { status: 200 }));
    const provider = new SonioxSpeechProvider();

    await expect(
      provider.synthesize(
        { lang: 'en', text: 'Hello', voice: 'Kayla', pitch: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'SpeechSynthesisPermanentError' });
  });
});
