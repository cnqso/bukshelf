import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validateUserAndTokenMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/access', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserAndTokenMock(...args),
}));

import { GET } from '@/app/api/usage/route';

const request = () =>
  new Request('http://localhost:3000/api/usage', {
    headers: { authorization: 'Bearer readest-token' },
  });

beforeEach(() => {
  process.env['SONIOX_API_KEY'] = 'soniox-secret';
  process.env['OPENROUTER_API_KEY'] = 'openrouter-secret';
  validateUserAndTokenMock.mockReset().mockResolvedValue({
    user: { id: 'reader-1' },
    token: 'readest-token',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('soniox.com')) {
        return Response.json({
          models: [
            {
              model: 'tts-rt-v2',
              days: ['2026-08-19'],
              total_cost_usd: '0.12',
              total_input_cost_usd: '0.01',
              total_output_cost_usd: '0.11',
              cost_usd: ['0.12'],
              input_cost_usd: ['0.01'],
              output_cost_usd: ['0.11'],
              total_num_requests: 3,
              total_input_text_tokens: 100,
              total_output_audio_tokens: 200,
              total_output_audio_duration_ms: 24_000,
              num_requests: [3],
              input_text_tokens: [100],
              output_audio_tokens: [200],
              output_audio_duration_ms: [24_000],
            },
          ],
        });
      }
      return Response.json({
        data: {
          label: 'sk-or-secret-label',
          creator_user_id: 'private-owner',
          usage: 5,
          usage_daily: 0.25,
          usage_weekly: 1.5,
          usage_monthly: 4,
          limit: 10,
          limit_remaining: 6,
          limit_reset: 'monthly',
        },
      });
    }),
  );
});

afterEach(() => {
  delete process.env['SONIOX_API_KEY'];
  delete process.env['OPENROUTER_API_KEY'];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('usage dashboard API', () => {
  it('requires authentication', async () => {
    validateUserAndTokenMock.mockResolvedValue({ user: null, token: null });
    const response = await GET(request());
    expect(response.status).toBe(403);
  });

  it('combines provider billing with local meters without exposing credentials', async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.providers.soniox.summary).toMatchObject({
      model: 'tts-rt-v2',
      total_cost_usd: '0.12',
      total_num_requests: 3,
    });
    expect(body.providers.openrouter.key).toMatchObject({
      usageDaily: 0.25,
      usageWeekly: 1.5,
      usageMonthly: 4,
      limitRemaining: 6,
    });
    expect(body.local.soniox.limits).toBeTruthy();
    expect(body.local.openrouter.limits).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('private-owner');
  });
});
