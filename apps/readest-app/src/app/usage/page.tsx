'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { bukshelfProviderUrl, fetchWithAuth } from '@/utils/fetch';

interface UsageTotals {
  requests: number;
  failures: number;
  rejected: number;
  inputUnits: number;
  outputUnits: number;
  totalUnits: number;
  exactUnits: number;
  estimatedUnits: number;
  costUsd: number;
}

interface UsageEvent {
  id: number;
  request_id: string;
  provider: string;
  operation: string;
  model: string;
  status: string;
  http_status: number | null;
  input_units: number;
  output_units: number;
  total_units: number;
  units_exact: number;
  cost_usd: number | null;
  duration_ms: number | null;
  error_category: string | null;
  created_at: number;
}

interface ProviderLimits {
  maxConcurrent?: number;
  requestsPerMinute?: number;
  tokensPerDay?: number;
  maxOutputTokens?: number;
  maxQueueSize?: number;
  tokensPerMinutePerUser?: number;
}

interface UsageData {
  generatedAt: string;
  sessionStartedAt: string;
  local: Record<
    'openrouter' | 'soniox',
    {
      today: UsageTotals;
      session: UsageTotals;
      allTime: UsageTotals;
      limits?: ProviderLimits | null;
    }
  >;
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
    soniox: { inputTextPerMillion: number; outputAudioPerMillion: number };
    openrouter: { chatModel: string | null };
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
const formatDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return '—';
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

const ExactBadge = ({ exact }: { exact: boolean }) => (
  <span className={`badge badge-outline ${exact ? 'badge-success' : 'badge-warning'}`}>
    {exact ? 'Exact' : 'Estimated'}
  </span>
);

export default function UsagePage() {
  const router = useRouter();
  const { token } = useAuth();
  const [data, setData] = useState<UsageData | null>(null);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetchWithAuth(bukshelfProviderUrl('/api/usage'), { method: 'GET' });
      setData((await response.json()) as UsageData);
      const eventResponse = await fetchWithAuth(bukshelfProviderUrl('/api/usage/events?limit=15'), {
        method: 'GET',
      });
      setEvents(((await eventResponse.json()) as { events: UsageEvent[] }).events ?? []);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to load usage');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh, token]);

  // Provider-reported billing is exact; locally recorded units are estimates
  // unless the provider reported them.
  const sonioxToday = data?.local.soniox.today;
  const openRouterToday = data?.local.openrouter.today;
  const providerCostToday =
    (data?.providers.openrouter.key?.usageDaily ?? 0) +
    (sonioxToday && data?.providers.soniox.summary
      ? Number(data.providers.soniox.summary.cost_usd.at(-1) ?? 0)
      : 0);
  const totalToday =
    providerCostToday || (sonioxToday?.costUsd ?? 0) + (openRouterToday?.costUsd ?? 0);

  if (!token) {
    return (
      <main className='bg-base-200 flex min-h-screen items-center justify-center p-6'>
        <section className='bg-base-100 w-full max-w-md rounded-2xl p-8 text-center shadow-sm'>
          <PiPulse className='text-primary mx-auto size-10' />
          <h1 className='mt-4 text-2xl font-semibold'>Usage &amp; Costs</h1>
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
              <h1 className='text-2xl font-semibold sm:text-3xl'>Usage &amp; Costs</h1>
              <p className='text-base-content/55 mt-0.5 text-sm'>
                Provider billing + persistent local accounting
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
            <div className='mt-2 text-xs opacity-70'>
              Provider-reported spend when available, otherwise local estimates
            </div>
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
            <div className='text-base-content/50 mt-2 text-xs'>TTS v2 only · exact billing</div>
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
              <ExactBadge exact={false} />
            </div>

            {data?.providers.soniox.error && (
              <p className='text-error mb-4 text-sm'>{data.providers.soniox.error}</p>
            )}
            <div className='grid grid-cols-2 gap-x-6 gap-y-5'>
              <Stat label='Requests today' value={formatNumber(sonioxToday?.requests ?? 0)} />
              <Stat label='Failures today' value={formatNumber(sonioxToday?.failures ?? 0)} />
              <Stat
                label='Estimated tokens today'
                value={formatNumber(sonioxToday?.estimatedUnits ?? 0)}
              />
              <Stat
                label='All-time metered tokens'
                value={formatNumber(data?.local.soniox.allTime.totalUnits ?? 0)}
              />
              <Stat
                label='Session requests'
                value={formatNumber(data?.local.soniox.session.requests ?? 0)}
              />
              <Stat
                label='Session failures'
                value={formatNumber(data?.local.soniox.session.failures ?? 0)}
              />
            </div>
            <div className='mt-6'>
              <LimitBar
                value={sonioxToday?.totalUnits ?? 0}
                limit={data?.local.soniox.limits?.tokensPerDay ?? 500_000}
              />
            </div>

            {data?.providers.soniox.summary && (
              <div className='mt-6 border-t border-base-300 pt-5'>
                <div className='text-base-content/55 mb-3 text-xs'>
                  Seven-day provider-reported cost
                </div>
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
              <ExactBadge exact={(openRouterToday?.exactUnits ?? 0) > 0} />
            </div>

            {data?.providers.openrouter.error && (
              <p className='text-error mb-4 text-sm'>{data.providers.openrouter.error}</p>
            )}
            <div className='grid grid-cols-2 gap-x-6 gap-y-5'>
              <Stat
                label='Input tokens today'
                value={formatNumber(openRouterToday?.inputUnits ?? 0)}
              />
              <Stat
                label='Output tokens today'
                value={formatNumber(openRouterToday?.outputUnits ?? 0)}
              />
              <Stat
                label='Total tokens today'
                value={formatNumber(openRouterToday?.totalUnits ?? 0)}
              />
              <Stat label='Requests today' value={formatNumber(openRouterToday?.requests ?? 0)} />
              <Stat label='Rejected today' value={formatNumber(openRouterToday?.rejected ?? 0)} />
              <Stat
                label='All-time tokens'
                value={formatNumber(data?.local.openrouter.allTime.totalUnits ?? 0)}
              />
            </div>
            <div className='mt-6'>
              <LimitBar
                value={openRouterToday?.totalUnits ?? 0}
                limit={data?.local.openrouter.limits?.tokensPerDay ?? 5_000_000}
              />
            </div>

            {data?.providers.openrouter.key?.limitRemaining != null && (
              <div className='bg-base-200 mt-6 rounded-xl p-4 text-sm'>
                <div className='text-base-content/60 text-xs'>
                  {formatMoney(data.providers.openrouter.key.limitRemaining)} remaining on this key
                </div>
              </div>
            )}
          </section>
        </div>

        <section className='bg-base-100 mt-6 rounded-2xl p-5 shadow-sm sm:p-6'>
          <h2 className='mb-4 text-lg font-semibold'>Recent requests</h2>
          <div className='overflow-x-auto'>
            <table className='table table-sm'>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Provider</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th className='text-right'>In / Out</th>
                  <th className='text-right'>Duration</th>
                  <th className='text-right'>Cost</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={7} className='text-base-content/50 py-6 text-center'>
                      No provider requests recorded yet.
                    </td>
                  </tr>
                )}
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className='whitespace-nowrap tabular-nums'>
                      {new Date(event.created_at).toLocaleTimeString()}
                    </td>
                    <td>{event.provider}</td>
                    <td>{event.operation}</td>
                    <td>
                      <span
                        className={`badge badge-sm ${
                          event.status === 'success'
                            ? 'badge-success'
                            : event.status === 'failed'
                              ? 'badge-error'
                              : 'badge-warning'
                        }`}
                      >
                        {event.status}
                      </span>
                      {event.error_category && (
                        <span className='text-base-content/50 ml-1 text-xs'>
                          {event.error_category}
                        </span>
                      )}
                    </td>
                    <td className='text-right tabular-nums'>
                      {formatNumber(event.input_units)} / {formatNumber(event.output_units)}
                      <span className='text-base-content/45 ml-1 text-[10px]'>
                        [{event.units_exact ? 'exact' : 'est'}]
                      </span>
                    </td>
                    <td className='text-right tabular-nums'>{formatDuration(event.duration_ms)}</td>
                    <td className='text-right tabular-nums'>
                      {event.cost_usd === null ? '—' : formatMoney(event.cost_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <footer className='text-base-content/50 mt-6 flex flex-col gap-1 px-1 text-xs sm:flex-row sm:justify-between'>
          <div>
            Soniox rates: ${data?.pricing.soniox.inputTextPerMillion ?? 4}/M text + $
            {data?.pricing.soniox.outputAudioPerMillion ?? 21.5}/M audio tokens. Local token counts
            are estimates unless marked exact; all accounting persists in SQLite.
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
