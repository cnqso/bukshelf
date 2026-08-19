'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PiArrowLeft,
  PiBrain,
  PiCurrencyDollar,
  PiPulse,
  PiSpeakerHigh,
  PiSpinner,
} from 'react-icons/pi';
import { useAuth } from '@/context/AuthContext';
import { fetchWithAuth } from '@/utils/fetch';

interface UsageData {
  generatedAt: string;
  local: {
    soniox: {
      activeRequests: number;
      queuedRequests: number;
      dailyRequests: number;
      dailyCharacters: number;
      dailyEstimatedTokens: number;
      minuteRequests: number;
      limits: {
        maxConcurrent: number;
        maxQueueSize: number;
        maxRequestsPerMinute: number;
        maxTokensPerMinutePerUser: number;
        maxTokensPerDay: number;
      };
    };
    openrouter: {
      activeRequests: number;
      requestsLastMinute: number;
      estimatedInputTokensToday: number;
      actualInputTokensToday: number;
      actualOutputTokensToday: number;
      actualTotalTokensToday: number;
      rejectedRequestsToday: number;
      totalRequestsToday: number;
      limits: {
        maxConcurrent: number;
        requestsPerMinute: number;
        tokensPerDay: number;
        maxOutputTokens: number;
      };
    };
  };
  providers: {
    soniox: {
      configured: boolean;
      error: string | null;
      summary: null | {
        days: string[];
        total_cost_usd: string;
        total_num_requests: number;
        total_input_text_tokens: number;
        total_output_audio_tokens: number;
        total_output_audio_duration_ms: number;
        cost_usd: string[];
        num_requests: number[];
        input_text_tokens: number[];
        output_audio_tokens: number[];
        output_audio_duration_ms: number[];
      };
    };
    openrouter: {
      configured: boolean;
      error: string | null;
      key: null | {
        usage: number;
        usageDaily: number;
        usageWeekly: number;
        usageMonthly: number;
        limit: number | null;
        limitRemaining: number | null;
        limitReset: string | null;
        isFreeTier: boolean;
      };
    };
  };
  pricing: {
    soniox: {
      inputTextPerMillion: number;
      outputAudioPerMillion: number;
      approximatePerAudioHour: number;
    };
    openrouter: { chatModel: string; embeddingModel: string };
  };
}

const formatMoney = (value: number) => {
  if (value > 0 && value < 0.0001) return '<$0.0001';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  });
};

const formatNumber = (value: number) => value.toLocaleString();
const formatDuration = (milliseconds: number) => {
  const minutes = milliseconds / 60_000;
  return minutes < 1 ? `${Math.round(milliseconds / 1000)} sec` : `${minutes.toFixed(1)} min`;
};
const percent = (value: number, limit: number) =>
  limit > 0 ? Math.min(100, (value / limit) * 100) : 0;

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className='text-base-content/55 text-xs'>{label}</div>
    <div className='mt-1 text-lg font-semibold tabular-nums'>{value}</div>
  </div>
);

const LimitBar = ({ value, limit }: { value: number; limit: number }) => (
  <div>
    <div className='mb-1.5 flex justify-between text-xs tabular-nums'>
      <span className='text-base-content/55'>Daily safety budget</span>
      <span>
        {formatNumber(value)} / {formatNumber(limit)} tokens
      </span>
    </div>
    <div className='bg-base-300 h-2 overflow-hidden rounded-full'>
      <div
        className='bg-primary h-full rounded-full transition-[width]'
        style={{ width: `${percent(value, limit)}%` }}
      />
    </div>
  </div>
);

export default function UsagePage() {
  const router = useRouter();
  const { token } = useAuth();
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/usage', { method: 'GET' });
      setData((await response.json()) as UsageData);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to load usage');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refresh, token]);

  const sonioxToday = useMemo(() => {
    const summary = data?.providers.soniox.summary;
    if (!summary || summary.days.length === 0) return null;
    const index = summary.days.length - 1;
    return {
      cost: Number(summary.cost_usd[index] ?? 0),
      requests: summary.num_requests[index] ?? 0,
      inputTokens: summary.input_text_tokens[index] ?? 0,
      outputTokens: summary.output_audio_tokens[index] ?? 0,
      durationMs: summary.output_audio_duration_ms[index] ?? 0,
    };
  }, [data]);
  const openRouterToday = data?.providers.openrouter.key?.usageDaily ?? 0;
  const totalToday = (sonioxToday?.cost ?? 0) + openRouterToday;

  if (!token) {
    return (
      <main className='bg-base-200 flex min-h-screen items-center justify-center p-6'>
        <section className='bg-base-100 w-full max-w-md rounded-2xl p-8 text-center shadow-sm'>
          <PiPulse className='text-primary mx-auto size-10' />
          <h1 className='mt-4 text-2xl font-semibold'>Usage & Costs</h1>
          <p className='text-base-content/60 mt-2'>Sign in to view private provider usage.</p>
          <button
            className='btn btn-primary mt-6'
            onClick={() => router.push('/auth?redirect=/usage')}
          >
            Sign In
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className='bg-base-200 min-h-screen overflow-y-auto'>
      <div className='mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10'>
        <header className='mb-8 flex items-center justify-between gap-4'>
          <div className='flex items-center gap-3'>
            <button
              className='btn btn-ghost btn-circle btn-sm'
              aria-label='Back to library'
              onClick={() => router.push('/')}
            >
              <PiArrowLeft className='size-5' />
            </button>
            <div>
              <h1 className='text-2xl font-semibold sm:text-3xl'>Usage & Costs</h1>
              <p className='text-base-content/55 mt-0.5 text-sm'>
                Provider billing + live safeguards
              </p>
            </div>
          </div>
          <button
            className='btn btn-outline btn-sm'
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? <PiSpinner className='size-4 animate-spin' /> : 'Refresh'}
          </button>
        </header>

        {error && <div className='alert alert-error mb-6 text-sm'>{error}</div>}

        <section className='mb-6 grid gap-4 sm:grid-cols-3'>
          <div className='bg-primary text-primary-content rounded-2xl p-5 shadow-sm sm:col-span-1'>
            <div className='flex items-center gap-2 text-sm opacity-75'>
              <PiCurrencyDollar className='size-5' /> Today
            </div>
            <div className='mt-3 text-4xl font-semibold tabular-nums'>
              {data ? formatMoney(totalToday) : '—'}
            </div>
            <div className='mt-2 text-xs opacity-70'>Exact provider-reported spend</div>
          </div>
          <div className='bg-base-100 rounded-2xl p-5 shadow-sm'>
            <div className='text-base-content/55 text-sm'>OpenRouter this month</div>
            <div className='mt-3 text-3xl font-semibold tabular-nums'>
              {data?.providers.openrouter.key
                ? formatMoney(data.providers.openrouter.key.usageMonthly)
                : '—'}
            </div>
            <div className='text-base-content/50 mt-2 text-xs'>Across this API key</div>
          </div>
          <div className='bg-base-100 rounded-2xl p-5 shadow-sm'>
            <div className='text-base-content/55 text-sm'>Soniox last 7 days</div>
            <div className='mt-3 text-3xl font-semibold tabular-nums'>
              {data?.providers.soniox.summary
                ? formatMoney(Number(data.providers.soniox.summary.total_cost_usd))
                : '—'}
            </div>
            <div className='text-base-content/50 mt-2 text-xs'>TTS v2 only</div>
          </div>
        </section>

        <div className='grid gap-6 lg:grid-cols-2'>
          <section className='bg-base-100 rounded-2xl p-5 shadow-sm sm:p-6'>
            <div className='mb-5 flex items-start justify-between gap-4'>
              <div className='flex gap-3'>
                <div className='bg-secondary/15 text-secondary flex size-10 items-center justify-center rounded-xl'>
                  <PiSpeakerHigh className='size-5' />
                </div>
                <div>
                  <h2 className='text-lg font-semibold'>Soniox TTS</h2>
                  <p className='text-base-content/50 text-xs'>tts-rt-v2 · Kayla</p>
                </div>
              </div>
              <span className='badge badge-success badge-outline'>Exact billing</span>
            </div>

            {data?.providers.soniox.error && (
              <p className='text-error mb-4 text-sm'>{data.providers.soniox.error}</p>
            )}
            <div className='grid grid-cols-2 gap-x-6 gap-y-5'>
              <Stat label='Cost today' value={sonioxToday ? formatMoney(sonioxToday.cost) : '—'} />
              <Stat label='Requests today' value={formatNumber(sonioxToday?.requests ?? 0)} />
              <Stat label='Input text tokens' value={formatNumber(sonioxToday?.inputTokens ?? 0)} />
              <Stat
                label='Output audio tokens'
                value={formatNumber(sonioxToday?.outputTokens ?? 0)}
              />
              <Stat label='Generated audio' value={formatDuration(sonioxToday?.durationMs ?? 0)} />
              <Stat
                label='Live / queued'
                value={`${data?.local.soniox.activeRequests ?? 0} / ${data?.local.soniox.queuedRequests ?? 0}`}
              />
            </div>
            <div className='mt-6'>
              <LimitBar
                value={data?.local.soniox.dailyEstimatedTokens ?? 0}
                limit={data?.local.soniox.limits.maxTokensPerDay ?? 1}
              />
            </div>

            {data?.providers.soniox.summary && (
              <div className='mt-6 border-t border-base-300 pt-5'>
                <div className='text-base-content/55 mb-3 text-xs'>Seven-day cost</div>
                <div className='flex h-20 items-end gap-2'>
                  {data.providers.soniox.summary.days.map((day, index) => {
                    const costs = data.providers.soniox.summary!.cost_usd.map(Number);
                    const maxCost = Math.max(...costs, 0.000001);
                    const cost = costs[index] ?? 0;
                    return (
                      <div key={day} className='flex min-w-0 flex-1 flex-col items-center gap-1'>
                        <div className='flex h-14 w-full items-end'>
                          <div
                            className='bg-secondary/70 hover:bg-secondary w-full rounded-t transition-colors'
                            style={{ height: `${Math.max(3, (cost / maxCost) * 100)}%` }}
                            title={`${day}: ${formatMoney(cost)}`}
                          />
                        </div>
                        <span className='text-base-content/45 text-[10px]'>
                          {new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
                            weekday: 'short',
                            timeZone: 'UTC',
                          })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <section className='bg-base-100 rounded-2xl p-5 shadow-sm sm:p-6'>
            <div className='mb-5 flex items-start justify-between gap-4'>
              <div className='flex gap-3'>
                <div className='bg-accent/15 text-accent flex size-10 items-center justify-center rounded-xl'>
                  <PiBrain className='size-5' />
                </div>
                <div>
                  <h2 className='text-lg font-semibold'>OpenRouter</h2>
                  <p className='text-base-content/50 max-w-64 truncate text-xs'>
                    {data?.pricing.openrouter.chatModel ?? 'Reader AI'}
                  </p>
                </div>
              </div>
              <span className='badge badge-success badge-outline'>Exact billing</span>
            </div>

            {data?.providers.openrouter.error && (
              <p className='text-error mb-4 text-sm'>{data.providers.openrouter.error}</p>
            )}
            <div className='grid grid-cols-2 gap-x-6 gap-y-5'>
              <Stat label='Cost today' value={formatMoney(openRouterToday)} />
              <Stat
                label='Cost this week'
                value={formatMoney(data?.providers.openrouter.key?.usageWeekly ?? 0)}
              />
              <Stat
                label='Input tokens this process'
                value={formatNumber(data?.local.openrouter.actualInputTokensToday ?? 0)}
              />
              <Stat
                label='Output tokens this process'
                value={formatNumber(data?.local.openrouter.actualOutputTokensToday ?? 0)}
              />
              <Stat
                label='Requests this process'
                value={formatNumber(data?.local.openrouter.totalRequestsToday ?? 0)}
              />
              <Stat
                label='Rejected today'
                value={formatNumber(data?.local.openrouter.rejectedRequestsToday ?? 0)}
              />
            </div>
            <div className='mt-6'>
              <LimitBar
                value={
                  (data?.local.openrouter.actualTotalTokensToday ?? 0) +
                  (data?.local.openrouter.estimatedInputTokensToday ?? 0)
                }
                limit={data?.local.openrouter.limits.tokensPerDay ?? 1}
              />
            </div>

            <div className='bg-base-200 mt-6 rounded-xl p-4 text-sm'>
              <div className='text-base-content/55 text-xs'>Embedding model</div>
              <div className='mt-1 break-all font-medium'>
                {data?.pricing.openrouter.embeddingModel ?? '—'}
              </div>
              {data?.providers.openrouter.key?.limitRemaining != null && (
                <div className='text-base-content/60 mt-3 text-xs'>
                  {formatMoney(data.providers.openrouter.key.limitRemaining)} remaining on this key
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className='text-base-content/50 mt-6 flex flex-col gap-1 px-1 text-xs sm:flex-row sm:justify-between'>
          <div>
            <div>
              Soniox rates: ${data?.pricing.soniox.inputTextPerMillion ?? 4}/M text + $
              {data?.pricing.soniox.outputAudioPerMillion ?? 21.5}/M audio tokens.
            </div>
            <div>Local OpenRouter token counters reset when this container restarts.</div>
          </div>
          <span>
            {data
              ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`
              : loading
                ? 'Loading provider totals…'
                : 'Waiting for usage data'}
          </span>
        </footer>
      </div>
    </main>
  );
}
