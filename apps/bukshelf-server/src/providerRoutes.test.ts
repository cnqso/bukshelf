import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { createHandler } from './app';
import { OpenRouterService } from './openRouter';
import { SonioxService } from './soniox';
import { UsageStore } from './usageStore';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';

describe('provider routes HTTP contract', () => {
  let store: AuthStore;
  let handler: ReturnType<typeof createHandler>;
  let authorization: string;
  let usage: UsageStore;

  const buildHandler = (options: { openRouter?: boolean; soniox?: boolean } = {}) => {
    usage = new UsageStore(store.database);
    return createHandler({
      auth: new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes'),
      providers: {
        usage,
        openRouter: options.openRouter ? new OpenRouterService({ apiKey: 'k' }, usage) : undefined,
        soniox: options.soniox ? new SonioxService({ apiKey: 'k' }, usage) : undefined,
      },
    });
  };

  beforeEach(() => {
    store = new AuthStore(':memory:');
    store.createOwner({ id: ownerId, email: 'owner@example.com', passwordHash: 'unused' });
    const auth = new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes');
    authorization = `Bearer ${auth.issue(store.getOwner()!).accessToken}`;
    handler = buildHandler();
  });

  afterEach(() => store.close());

  test('rejects anonymous access to AI, TTS, and usage endpoints', async () => {
    for (const path of ['/api/ai/chat', '/api/tts/soniox', '/api/usage']) {
      const response = await handler(new Request(`http://localhost${path}`));
      expect(response.status).toBe(401);
    }
  });

  test('reports 503 for unconfigured providers instead of falling back', async () => {
    const chat = await handler(
      new Request('http://localhost/api/ai/chat', {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(chat.status).toBe(503);

    const tts = await handler(
      new Request('http://localhost/api/tts/soniox', {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({ input: 'hi', voice: 'Kayla', lang: 'en' }),
      }),
    );
    expect(tts.status).toBe(503);
  });

  test('exposes configuration snapshots for configured providers', async () => {
    handler = buildHandler({ openRouter: true, soniox: true });
    const chat = await handler(
      new Request('http://localhost/api/ai/chat', { headers: { authorization } }),
    );
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ model: 'google/gemini-3.6-flash' });

    const tts = await handler(
      new Request('http://localhost/api/tts/soniox', { headers: { authorization } }),
    );
    expect(tts.status).toBe(200);
    expect(await tts.json()).toMatchObject({ model: 'tts-rt-v2', voices: [{ id: 'Kayla' }] });
  });

  test('serves persistent usage accounting to the owner only', async () => {
    usage.record({
      requestId: 'req-1',
      provider: 'openrouter',
      operation: 'chat',
      model: 'google/gemini-3.6-flash',
      ownerId,
      status: 'success',
      httpStatus: 200,
      inputUnits: 10,
      outputUnits: 4,
      totalUnits: 14,
      unitsExact: true,
      costUsd: 0.01,
      costSource: 'provider',
      durationMs: 120,
    });

    const dashboard = await handler(
      new Request('http://localhost/api/usage', { headers: { authorization } }),
    );
    expect(dashboard.status).toBe(200);
    const body = (await dashboard.json()) as {
      local: Record<
        string,
        { today: { requests: number }; allTime: { requests: number; totalUnits: number } }
      >;
    };
    expect(body.local.openrouter.today.requests).toBe(1);
    expect(body.local.openrouter.allTime.totalUnits).toBe(14);
    expect(body.local.soniox.allTime.requests).toBe(0);

    const summary = await handler(
      new Request('http://localhost/api/usage/summary?days=7', { headers: { authorization } }),
    );
    expect(summary.status).toBe(200);
    expect((await summary.json()).rows[0]).toMatchObject({
      provider: 'openrouter',
      requests: 1,
      total_units: 14,
    });

    const events = await handler(
      new Request('http://localhost/api/usage/events?limit=10', { headers: { authorization } }),
    );
    expect(events.status).toBe(200);
    expect((await events.json()).events[0]).toMatchObject({
      request_id: 'req-1',
      status: 'success',
    });
  });

  test('advertises migrated capabilities in discovery', async () => {
    const bare = await createHandler({
      auth: new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes'),
    })(new Request('http://localhost/.well-known/bukshelf'));
    expect((await bare.json()).capabilities).toMatchObject({
      readerAI: false,
      textToSpeech: false,
      usageMetering: false,
    });

    handler = buildHandler({ openRouter: true, soniox: true });
    const configured = await handler(new Request('http://localhost/.well-known/bukshelf'));
    expect((await configured.json()).capabilities).toMatchObject({
      readerAI: true,
      textToSpeech: true,
      usageMetering: true,
    });
  });
});
