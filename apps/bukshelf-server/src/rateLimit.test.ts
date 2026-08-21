import { describe, expect, test } from 'bun:test';
import { RateLimiter } from './rateLimit';

describe('RateLimiter', () => {
  test('grants up to maxConcurrent slots and rejects beyond them without a queue', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const first = await limiter.acquire();
    expect(first.accepted).toBe(true);
    const second = await limiter.acquire(undefined, Date.now());
    expect(second).toMatchObject({ accepted: false, reason: 'queue_limit' });
    if (first.accepted) first.release();
  });

  test('queues waiters and grants them when a slot is released', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, maxQueueSize: 4 });
    const first = await limiter.acquire();
    const queued = limiter.acquire();
    expect(limiter.queuedRequests).toBe(1);
    if (first.accepted) first.release();
    const decision = await queued;
    expect(decision.accepted).toBe(true);
    if (decision.accepted) decision.release();
  });

  test('resolves queued waiters as cancelled on abort', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, maxQueueSize: 2 });
    const first = await limiter.acquire();
    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();
    expect(await queued).toMatchObject({ accepted: false, reason: 'cancelled' });
    if (first.accepted) first.release();
  });

  test('enforces requests-per-minute with retry-after', async () => {
    const now = Date.UTC(2026, 0, 15, 12);
    const limiter = new RateLimiter({ maxConcurrent: 5, requestsPerMinute: 2 });
    expect((await limiter.acquire(undefined, now)).accepted).toBe(true);
    expect((await limiter.acquire(undefined, now + 1000)).accepted).toBe(true);
    const rejected = await limiter.acquire(undefined, now + 2000);
    expect(rejected).toMatchObject({
      accepted: false,
      reason: 'request_rate_limit',
      retryAfterSeconds: 58,
    });
    // Window rolls after sixty seconds.
    expect((await limiter.acquire(undefined, now + 61_000)).accepted).toBe(true);
  });
});
