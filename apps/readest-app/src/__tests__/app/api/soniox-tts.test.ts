import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const validateUserAndTokenMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/access', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserAndTokenMock(...args),
}));

import { GET, POST } from '@/app/api/tts/soniox/route';

const makeRequest = (body: unknown) =>
  new NextRequest('http://localhost:3000/api/tts/soniox', {
    method: 'POST',
    headers: {
      authorization: 'Bearer readest-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env['SONIOX_API_KEY'] = 'test-soniox-key';
  validateUserAndTokenMock.mockReset().mockResolvedValue({
    user: { id: 'reader-1' },
    token: 'readest-token',
  });
  fetchMock = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  delete process.env['SONIOX_API_KEY'];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Soniox TTS proxy route', () => {
  it('requires a signed-in Readest user before exposing availability', async () => {
    validateUserAndTokenMock.mockResolvedValue({ user: null, token: null });
    const request = new NextRequest('http://localhost:3000/api/tts/soniox', {
      headers: { authorization: 'Bearer invalid' },
    });

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the configured model and Kayla voice without exposing the API key', async () => {
    const request = new NextRequest('http://localhost:3000/api/tts/soniox', {
      headers: { authorization: 'Bearer readest-token' },
    });

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      model: 'tts-rt-v2',
      voices: [{ id: 'Kayla', name: 'Kayla', language: 'en' }],
      usage: {
        activeRequests: expect.any(Number),
        totalRequests: expect.any(Number),
        totalCharacters: expect.any(Number),
        totalEstimatedTokens: expect.any(Number),
        dailyEstimatedTokens: expect.any(Number),
      },
    });
    expect(JSON.stringify(body)).not.toContain('test-soniox-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps model, voice, format, and upstream URL under server control', async () => {
    const response = await POST(
      makeRequest({
        input: 'A short test sentence.',
        lang: 'en-US',
        voice: 'Kayla',
        model: 'attacker-model',
        url: 'https://evil.example.com',
      }),
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://tts-rt.soniox.com/tts');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-soniox-key',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model: 'tts-rt-v2',
      language: 'en',
      voice: 'Kayla',
      audio_format: 'mp3',
      text: 'A short test sentence.',
      client_reference_id: expect.any(String),
    });
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  });

  it('rejects invalid text and voices without spending a Soniox request', async () => {
    const missingText = await POST(makeRequest({ input: '', lang: 'en', voice: 'Kayla' }));
    const wrongVoice = await POST(makeRequest({ input: 'Hello', lang: 'en', voice: 'Other' }));

    expect(missingText.status).toBe(400);
    expect(wrongVoice.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the server has no Soniox key', async () => {
    delete process.env['SONIOX_API_KEY'];

    const response = await POST(makeRequest({ input: 'Hello', lang: 'en', voice: 'Kayla' }));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a safe upstream error without exposing credentials', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error_type: 'limit_exceeded',
          error_message: 'Rate limit reached',
          request_id: 'soniox-request-1',
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );

    const response = await POST(makeRequest({ input: 'Hello', lang: 'en', voice: 'Kayla' }));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({
      error: {
        message: 'Rate limit reached',
        type: 'limit_exceeded',
        requestId: 'soniox-request-1',
      },
    });
    expect(JSON.stringify(body)).not.toContain('test-soniox-key');
  });

  it('writes structured usage logs without logging book text or credentials', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const privateText = 'Private words from my book.';

    const response = await POST(makeRequest({ input: privateText, lang: 'en', voice: 'Kayla' }));

    expect(response.status).toBe(200);
    const logs = info.mock.calls.map(([message]) => String(message));
    expect(logs.some((message) => message.includes('"event":"completed"'))).toBe(true);
    expect(logs.join('\n')).not.toContain(privateText);
    expect(logs.join('\n')).not.toContain('test-soniox-key');
    expect(logs.join('\n')).toContain('"totalEstimatedTokens"');
  });
});
