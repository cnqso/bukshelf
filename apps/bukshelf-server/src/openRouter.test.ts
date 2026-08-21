import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { OpenRouterService, type OpenRouterConfig } from './openRouter';
import { UsageStore } from './usageStore';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';

interface TestContext {
  store: AuthStore;
  usage: UsageStore;
  authorization: string;
  upstream?: ReturnType<typeof Bun.serve>;
}

let context: TestContext;

const makeService = (overrides: Partial<OpenRouterConfig> = {}): OpenRouterService =>
  new OpenRouterService(
    {
      apiKey: 'test-openrouter-key',
      baseUrl: context.upstream ? `http://localhost:${context.upstream.port}/v1` : undefined,
      maxInputCharacters: 1000,
      tokensPerDay: 5_000_000,
      ...overrides,
    },
    context.usage,
  );

const chatRequest = (body: unknown, init: RequestInit = {}): Request =>
  new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: {
      authorization: context.authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...init,
  });

const sseResponse = (...events: unknown[]): Response =>
  new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

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

describe('OpenRouter chat proxy', () => {
  test('streams text deltas and records exact provider usage', async () => {
    context.upstream = Bun.serve({
      port: 0,
      fetch: () =>
        sseResponse(
          { choices: [{ delta: { content: 'Hello' } }] },
          { choices: [{ delta: { content: ' world' } }] },
          { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0002 } },
        ),
    });
    const service = makeService();
    const response = await service.handleChatPost(
      chatRequest({ messages: [{ role: 'user', content: 'Summarize this chapter' }] }),
      ownerId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(await response.text()).toBe('Hello world');

    const totals = context.usage.totals('openrouter');
    expect(totals).toMatchObject({
      requests: 1,
      failures: 0,
      inputUnits: 10,
      outputUnits: 5,
      totalUnits: 15,
      exactUnits: 15,
      estimatedUnits: 0,
    });
    expect(totals.costUsd).toBeCloseTo(0.0002);
  });

  test('tolerates malformed SSE lines and marks usage estimated when none is reported', async () => {
    context.upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          ': keep-alive\nnot-json\n\n' +
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n` +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const response = await makeService().handleChatPost(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      ownerId,
    );
    expect(await response.text()).toBe('ok');
    const totals = context.usage.totals('openrouter');
    expect(totals.requests).toBe(1);
    expect(totals.exactUnits).toBe(0);
    expect(totals.estimatedUnits).toBeGreaterThan(0);
  });

  test('validates the request body', async () => {
    const missing = await makeService().handleChatPost(chatRequest({}), ownerId);
    expect(missing.status).toBe(400);

    const badRole = await makeService().handleChatPost(
      chatRequest({ messages: [{ role: 'tool', content: 'hi' }] }),
      ownerId,
    );
    expect(badRole.status).toBe(400);
  });

  test('enforces the input size limit', async () => {
    const response = await makeService().handleChatPost(
      chatRequest({ messages: [{ role: 'user', content: 'a'.repeat(2000) }] }),
      ownerId,
    );
    expect(response.status).toBe(413);
  });

  test('enforces the daily token budget and records the rejection', async () => {
    const service = makeService({ tokensPerDay: 1 });
    const response = await service.handleChatPost(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      ownerId,
    );
    expect(response.status).toBe(429);
    expect((await response.json()).error.type).toBe('daily_token_limit');
    expect(context.usage.totals('openrouter')).toMatchObject({ rejected: 1, requests: 0 });
  });

  test('surfaces upstream failures and records them', async () => {
    context.upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ error: { message: 'Rate limited by provider' } }, { status: 429 }),
    });
    const response = await makeService().handleChatPost(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      ownerId,
    );
    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toBe('Rate limited by provider');
    expect(context.usage.totals('openrouter')).toMatchObject({
      requests: 0,
      failures: 1,
    });
  });

  test('never logs API keys or prompt text', async () => {
    const logs: string[] = [];
    const original = { info: console.info, warn: console.warn, error: console.error };
    console.info = (...args: unknown[]) => logs.push(String(args[0]));
    console.warn = (...args: unknown[]) => logs.push(String(args[0]));
    console.error = (...args: unknown[]) => logs.push(String(args[0]));
    try {
      context.upstream = Bun.serve({
        port: 0,
        fetch: () =>
          sseResponse(
            { choices: [{ delta: { content: 'SECRET-PROMPT-REPLY' } }] },
            { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          ),
      });
      const secretPrompt = 'SECRET-PROMPT-TEXT-about-the-whole-book';
      const response = await makeService().handleChatPost(
        chatRequest({ messages: [{ role: 'user', content: secretPrompt }] }),
        ownerId,
      );
      await response.text();
    } finally {
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
    const combined = logs.join('\n');
    expect(combined).toContain('openrouter_ai');
    expect(combined).not.toContain('test-openrouter-key');
    expect(combined).not.toContain('SECRET-PROMPT');
  });
});
