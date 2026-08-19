import { describe, expect, it } from 'vitest';
import { SonioxUsageMeter, estimateSonioxTokens } from '@/services/tts/sonioxUsageMeter';

const limits = {
  maxConcurrent: 2,
  maxQueueSize: 2,
  maxRequestsPerMinute: 3,
  maxTokensPerMinutePerUser: 10,
  maxTokensPerDay: 20,
};

describe('SonioxUsageMeter', () => {
  it('uses a conservative UTF-8 token estimate for both Latin and CJK text', () => {
    expect(estimateSonioxTokens('hello world')).toBeGreaterThan(0);
    expect(estimateSonioxTokens('你好世界')).toBeGreaterThanOrEqual(4);
  });

  it('meters accepted work and queues bursts above the upstream concurrency cap', async () => {
    const meter = new SonioxUsageMeter(limits);

    const first = await meter.acquire({ userId: 'u1', characters: 8, estimatedTokens: 3 });
    const second = await meter.acquire({ userId: 'u2', characters: 8, estimatedTokens: 3 });
    const queuedPromise = meter.acquire({ userId: 'u3', characters: 8, estimatedTokens: 3 });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(meter.snapshot()).toMatchObject({
      activeRequests: 2,
      queuedRequests: 1,
      totalRequests: 2,
      totalCharacters: 16,
      totalEstimatedTokens: 6,
    });

    if (first.accepted) meter.finish(first.lease);
    const queued = await queuedPromise;
    expect(queued.accepted).toBe(true);
    expect(meter.snapshot()).toMatchObject({ activeRequests: 2, queuedRequests: 0 });
  });

  it('enforces per-user minute and process-wide daily token budgets', async () => {
    const meter = new SonioxUsageMeter(limits);
    const first = await meter.acquire({ userId: 'u1', characters: 20, estimatedTokens: 8 });
    expect(first.accepted).toBe(true);
    if (first.accepted) meter.finish(first.lease);

    await expect(
      meter.acquire({ userId: 'u1', characters: 8, estimatedTokens: 3 }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'user_token_limit',
    });

    const second = await meter.acquire({ userId: 'u2', characters: 20, estimatedTokens: 10 });
    expect(second.accepted).toBe(true);
    if (second.accepted) meter.finish(second.lease);

    await expect(
      meter.acquire({ userId: 'u3', characters: 8, estimatedTokens: 3 }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'daily_token_limit',
    });
  });

  it('releases concurrency exactly once when a request completes', async () => {
    const meter = new SonioxUsageMeter(limits);
    const result = await meter.acquire({ userId: 'u1', characters: 4, estimatedTokens: 2 });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    meter.finish(result.lease);
    meter.finish(result.lease);

    expect(meter.snapshot().activeRequests).toBe(0);
  });

  it('applies the request-per-minute ceiling across all users', async () => {
    const meter = new SonioxUsageMeter({ ...limits, maxConcurrent: 10 });
    for (let i = 0; i < 3; i++) {
      const result = await meter.acquire({ userId: `u${i}`, characters: 2, estimatedTokens: 1 });
      expect(result.accepted).toBe(true);
      if (result.accepted) meter.finish(result.lease);
    }

    await expect(
      meter.acquire({ userId: 'u4', characters: 2, estimatedTokens: 1 }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'request_rate_limit',
    });
  });

  it('bounds the queue and removes cancelled requests while they wait', async () => {
    const meter = new SonioxUsageMeter({ ...limits, maxConcurrent: 1, maxQueueSize: 1 });
    const active = await meter.acquire({ userId: 'u1', characters: 2, estimatedTokens: 1 });
    const controller = new AbortController();
    const queued = meter.acquire(
      { userId: 'u2', characters: 2, estimatedTokens: 1 },
      controller.signal,
    );

    await expect(
      meter.acquire({ userId: 'u3', characters: 2, estimatedTokens: 1 }),
    ).resolves.toMatchObject({ accepted: false, reason: 'queue_limit' });
    controller.abort();
    await expect(queued).resolves.toMatchObject({ accepted: false, reason: 'request_cancelled' });
    expect(meter.snapshot().queuedRequests).toBe(0);
    if (active.accepted) meter.finish(active.lease);
  });
});
