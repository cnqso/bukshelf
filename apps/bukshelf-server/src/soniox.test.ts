import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { SonioxService, type SonioxConfig } from './soniox';
import { UsageStore } from './usageStore';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';

interface TestContext {
  store: AuthStore;
  usage: UsageStore;
  authorization: string;
  upstream?: ReturnType<typeof Bun.serve>;
}

let context: TestContext;

const makeService = (overrides: Partial<SonioxConfig> = {}): SonioxService =>
  new SonioxService(
    {
      apiKey: 'test-soniox-key',
      ttsUrl: context.upstream ? `http://localhost:${context.upstream.port}/tts` : undefined,
      maxConcurrent: 1,
      maxQueueSize: 0,
      ...overrides,
    },
    context.usage,
  );

const synthesizeRequest = (body: unknown, init: RequestInit = {}): Request =>
  new Request('http://localhost/api/tts/soniox', {
    method: 'POST',
    headers: {
      authorization: context.authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...init,
  });

const validBody = { input: 'Hello there', voice: 'Kayla', lang: 'en-US' };

beforeEach(() => {
  const store = new AuthStore(':memory:');
  store.createOwner({ id: ownerId, email: 'owner@example.com', passwordHash: 'unused' });
  const auth = new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes');
  context = {
    store,
    usage: new UsageStore(store.database),
    authorization: `Bearer ${auth.issue(store.getOwner()!).accessToken}`,
  };
});

afterEach(() => {
  context.upstream?.stop(true);
  context.store.close();
});

describe('Soniox TTS proxy', () => {
  test('passes MP3 audio through and records estimated usage', async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    context.upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }),
    });
    const response = await makeService().handleSynthesizePost(
      synthesizeRequest(validBody),
      ownerId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(mp3);

    const totals = context.usage.totals('soniox');
    expect(totals.requests).toBe(1);
    expect(totals.exactUnits).toBe(0);
    expect(totals.estimatedUnits).toBeGreaterThan(0);
    expect(context.usage.recentEvents(1)[0]).toMatchObject({
      provider: 'soniox',
      operation: 'tts',
      status: 'success',
      units_exact: 0,
    });
  });

  test('validates input, voice, and language', async () => {
    const service = makeService();
    for (const body of [
      {},
      { ...validBody, input: '' },
      { ...validBody, input: 'a'.repeat(5001) },
      { ...validBody, voice: 'Nova' },
      { ...validBody, lang: 'klingon' },
    ]) {
      const response = await service.handleSynthesizePost(synthesizeRequest(body), ownerId);
      expect(response.status).toBe(400);
    }
    expect(context.usage.totals('soniox').requests).toBe(0);
  });

  test('surfaces upstream errors with their status and type', async () => {
    context.upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error_type: 'insufficient_credits', error_message: 'Add credits' },
          { status: 402 },
        ),
    });
    const response = await makeService().handleSynthesizePost(
      synthesizeRequest(validBody),
      ownerId,
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toMatchObject({
      message: 'Add credits',
      type: 'insufficient_credits',
    });
    expect(context.usage.totals('soniox')).toMatchObject({ requests: 0, failures: 1 });
  });

  test('rejects empty upstream audio', async () => {
    context.upstream = Bun.serve({ port: 0, fetch: () => new Response(new Uint8Array(0)) });
    const response = await makeService().handleSynthesizePost(
      synthesizeRequest(validBody),
      ownerId,
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe('upstream_error');
    expect(context.usage.totals('soniox')).toMatchObject({ requests: 0, failures: 1 });
  });

  test('rejects concurrent requests beyond the configured slots', async () => {
    let releaseUpstream: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    context.upstream = Bun.serve({
      port: 0,
      fetch: async () => {
        await gate;
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    const service = makeService();
    const first = service.handleSynthesizePost(synthesizeRequest(validBody), ownerId);
    const second = await service.handleSynthesizePost(synthesizeRequest(validBody), ownerId);
    expect(second.status).toBe(429);
    expect((await second.json()).error.type).toBe('queue_limit');
    releaseUpstream?.();
    expect((await first).status).toBe(200);
  });

  test('resolves queued waiters as cancelled when the client aborts', async () => {
    let releaseUpstream: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    context.upstream = Bun.serve({
      port: 0,
      fetch: async () => {
        await gate;
        return new Response(new Uint8Array([1]));
      },
    });
    const controller = new AbortController();
    const service = makeService({ maxQueueSize: 4 });
    try {
      const first = service.handleSynthesizePost(synthesizeRequest(validBody), ownerId);
      const secondPromise = service.handleSynthesizePost(
        synthesizeRequest(validBody, { signal: controller.signal }),
        ownerId,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      const second = await secondPromise;
      expect(second.status).toBe(499);
      releaseUpstream?.();
      expect((await first).status).toBe(200);
    } finally {
      releaseUpstream?.();
    }
  });

  test('enforces the daily token budget', async () => {
    const response = await makeService({ tokensPerDay: 1 }).handleSynthesizePost(
      synthesizeRequest(validBody),
      ownerId,
    );
    expect(response.status).toBe(429);
    expect((await response.json()).error.type).toBe('daily_token_limit');
    expect(context.usage.totals('soniox')).toMatchObject({ rejected: 1 });
  });

  test('enforces the per-minute per-user token budget', async () => {
    const response = await makeService({ tokensPerMinutePerUser: 1 }).handleSynthesizePost(
      synthesizeRequest(validBody),
      ownerId,
    );
    expect(response.status).toBe(429);
    expect((await response.json()).error.type).toBe('user_token_limit');
  });

  test('never logs the requested text or API key', async () => {
    const logs: string[] = [];
    const original = { info: console.info, warn: console.warn, error: console.error };
    console.info = (...args: unknown[]) => logs.push(String(args[0]));
    console.warn = (...args: unknown[]) => logs.push(String(args[0]));
    console.error = (...args: unknown[]) => logs.push(String(args[0]));
    try {
      context.upstream = Bun.serve({
        port: 0,
        fetch: () => new Response(new Uint8Array([1, 2, 3])),
      });
      const secretText = 'SECRET-SPOILER-TEXT-from-chapter-twelve';
      const response = await makeService().handleSynthesizePost(
        synthesizeRequest({ ...validBody, input: secretText }),
        ownerId,
      );
      await response.arrayBuffer();
    } finally {
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
    const combined = logs.join('\n');
    expect(combined).toContain('soniox_tts');
    expect(combined).not.toContain('test-soniox-key');
    expect(combined).not.toContain('SECRET-SPOILER');
  });
});
