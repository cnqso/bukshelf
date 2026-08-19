import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateOpenRouterTokens, OpenRouterUsageMeter } from '@/services/ai/openRouterUsageMeter';

describe('OpenRouterUsageMeter', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('tracks exact provider usage after a request completes', () => {
    const meter = new OpenRouterUsageMeter();
    const result = meter.acquire(20);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    expect(result.snapshot.activeRequests).toBe(1);
    const snapshot = meter.finish(result.lease, {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });
    expect(snapshot).toMatchObject({
      activeRequests: 0,
      estimatedInputTokensToday: 0,
      actualInputTokensToday: 12,
      actualOutputTokensToday: 8,
      actualTotalTokensToday: 20,
    });
  });

  it('rejects work beyond the configured concurrency cap', () => {
    vi.stubEnv('OPENROUTER_MAX_CONCURRENT', '1');
    const meter = new OpenRouterUsageMeter();
    const first = meter.acquire(1);
    const second = meter.acquire(1);
    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, reason: 'concurrency_limit' });
  });

  it('uses a conservative UTF-8 estimate before provider usage is known', () => {
    expect(estimateOpenRouterTokens('reader ai')).toBe(3);
    expect(estimateOpenRouterTokens('')).toBe(1);
  });
});
