import { describe, expect, it } from 'vitest';
import { SonioxUsageMeter, estimateSonioxTokens } from '@/services/tts/sonioxUsageMeter';

const limits = {
  maxConcurrent: 2,
  maxRequestsPerMinute: 3,
  maxTokensPerMinutePerUser: 10,
  maxTokensPerDay: 20,
};

describe('SonioxUsageMeter', () => {
  it('uses a conservative UTF-8 token estimate for both Latin and CJK text', () => {
    expect(estimateSonioxTokens('hello world')).toBeGreaterThan(0);
    expect(estimateSonioxTokens('你好世界')).toBeGreaterThanOrEqual(4);
  });

  it('meters accepted work and caps concurrent upstream requests', () => {
    const meter = new SonioxUsageMeter(limits);

    const first = meter.begin({ userId: 'u1', characters: 8, estimatedTokens: 3 });
    const second = meter.begin({ userId: 'u2', characters: 8, estimatedTokens: 3 });
    const rejected = meter.begin({ userId: 'u3', characters: 8, estimatedTokens: 3 });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(rejected).toMatchObject({ accepted: false, reason: 'concurrency_limit' });
    expect(meter.snapshot()).toMatchObject({
      activeRequests: 2,
      totalRequests: 2,
      totalCharacters: 16,
      totalEstimatedTokens: 6,
    });
  });

  it('enforces per-user minute and process-wide daily token budgets', () => {
    const meter = new SonioxUsageMeter(limits);
    const first = meter.begin({ userId: 'u1', characters: 20, estimatedTokens: 8 });
    expect(first.accepted).toBe(true);
    if (first.accepted) meter.finish(first.lease);

    expect(meter.begin({ userId: 'u1', characters: 8, estimatedTokens: 3 })).toMatchObject({
      accepted: false,
      reason: 'user_token_limit',
    });

    const second = meter.begin({ userId: 'u2', characters: 20, estimatedTokens: 10 });
    expect(second.accepted).toBe(true);
    if (second.accepted) meter.finish(second.lease);

    expect(meter.begin({ userId: 'u3', characters: 8, estimatedTokens: 3 })).toMatchObject({
      accepted: false,
      reason: 'daily_token_limit',
    });
  });

  it('releases concurrency exactly once when a request completes', () => {
    const meter = new SonioxUsageMeter(limits);
    const result = meter.begin({ userId: 'u1', characters: 4, estimatedTokens: 2 });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    meter.finish(result.lease);
    meter.finish(result.lease);

    expect(meter.snapshot().activeRequests).toBe(0);
  });

  it('applies the request-per-minute ceiling across all users', () => {
    const meter = new SonioxUsageMeter({ ...limits, maxConcurrent: 10 });
    for (let i = 0; i < 3; i++) {
      const result = meter.begin({ userId: `u${i}`, characters: 2, estimatedTokens: 1 });
      expect(result.accepted).toBe(true);
      if (result.accepted) meter.finish(result.lease);
    }

    expect(meter.begin({ userId: 'u4', characters: 2, estimatedTokens: 1 })).toMatchObject({
      accepted: false,
      reason: 'request_rate_limit',
    });
  });
});
