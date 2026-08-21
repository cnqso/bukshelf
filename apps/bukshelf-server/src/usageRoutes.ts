import type { AuthService } from './auth';
import type { OpenRouterService } from './openRouter';
import type { SonioxService } from './soniox';
import type { UsageStore } from './usageStore';
import { logProviderEvent, newRequestId } from './telemetry';

const PROVIDER_TIMEOUT_MS = 8_000;
const PROVIDER_CACHE_TTL_MS = 15_000;

export interface UsageRouteConfig {
  auth: AuthService;
  usage: UsageStore;
  openRouter?: OpenRouterService;
  soniox?: SonioxService;
  publicOrigin?: string;
}

interface SonioxUsageEntry {
  model: string | null;
  days: string[];
  total_cost_usd: string;
  total_input_cost_usd: string;
  total_output_cost_usd: string;
  cost_usd: string[];
  input_cost_usd: string[];
  output_cost_usd: string[];
  total_num_requests: number;
  total_input_text_tokens: number;
  total_output_audio_tokens: number;
  total_output_audio_duration_ms: number;
  num_requests: number[];
  input_text_tokens: number[];
  output_audio_tokens: number[];
  output_audio_duration_ms: number[];
}

interface OpenRouterKeyData {
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
  is_free_tier?: boolean;
}

interface ProviderCache {
  expiresAt: number;
  sonioxSummary: SonioxUsageEntry | null;
  sonioxError: boolean;
  openRouterKey: {
    usage: number;
    usageDaily: number;
    usageWeekly: number;
    usageMonthly: number;
    limit: number | null;
    limitRemaining: number | null;
    limitReset: string | null;
    isFreeTier: boolean;
  } | null;
  openRouterError: boolean;
}

let providerCache: ProviderCache | null = null;

const utcMidnight = (offsetDays: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays),
  ).toISOString();
};

const fetchSonioxSummary = async (apiKey: string): Promise<SonioxUsageEntry | null> => {
  const url = new URL('https://api.soniox.com/v1/usage/summary');
  url.searchParams.set('start_time', utcMidnight(-6));
  url.searchParams.set('end_time', utcMidnight(1));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Soniox usage API returned ${response.status}`);
  const data = (await response.json()) as { models?: SonioxUsageEntry[] };
  return data.models?.find((entry) => entry.model === 'tts-rt-v2') ?? null;
};

const fetchOpenRouterKey = async (
  apiKey: string,
  baseUrl: string,
): Promise<NonNullable<ProviderCache['openRouterKey']>> => {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenRouter usage API returned ${response.status}`);
  const body = (await response.json()) as { data?: OpenRouterKeyData };
  const data = body.data ?? {};
  return {
    usage: data.usage ?? 0,
    usageDaily: data.usage_daily ?? 0,
    usageWeekly: data.usage_weekly ?? 0,
    usageMonthly: data.usage_monthly ?? 0,
    limit: data.limit ?? null,
    limitRemaining: data.limit_remaining ?? null,
    limitReset: data.limit_reset ?? null,
    isFreeTier: data.is_free_tier ?? false,
  };
};

const cors = (origin?: string) => ({
  ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
});

const json = (body: unknown, config: UsageRouteConfig, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', ...cors(config.publicOrigin), ...init.headers },
  });

/** Owner-authenticated provider usage accounting endpoints. */
export const handleUsageRoute = async (
  request: Request,
  config: UsageRouteConfig,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (!['/api/usage', '/api/usage/summary', '/api/usage/events'].includes(path)) return undefined;

  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors(config.publicOrigin) });
  if (request.method !== 'GET')
    return json({ error: 'Method not allowed' }, config, { status: 405 });
  if (!config.auth.authenticate(request))
    return json({ error: 'Not authenticated', code: 'AUTH' }, config, { status: 401 });

  try {
    if (path === '/api/usage/summary') {
      const days = Math.min(
        Math.max(Number.parseInt(url.searchParams.get('days') ?? '7', 10) || 7, 1),
        90,
      );
      const provider = url.searchParams.get('provider') || undefined;
      return json({ rows: config.usage.dailySeries(days, provider) }, config);
    }

    if (path === '/api/usage/events') {
      const limit = Math.min(
        Math.max(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1),
        200,
      );
      const provider = url.searchParams.get('provider') || undefined;
      return json({ events: config.usage.recentEvents(limit, provider) }, config);
    }

    // GET /api/usage — dashboard payload combining persistent local accounting
    // with provider-reported billing data.
    const sessionStartedAt = sessionStart();
    const localFor = (provider: 'openrouter' | 'soniox') => ({
      today: config.usage.totals(provider, utcDayStart()),
      session: config.usage.totals(provider, sessionStartedAt),
      allTime: config.usage.totals(provider),
      limits:
        provider === 'openrouter'
          ? (config.openRouter?.limits() ?? null)
          : (config.soniox?.limits() ?? null),
    });

    let providers: unknown;
    if (cacheValid(providerCache)) {
      providers = providerCacheToShape(providerCache!, config);
    } else {
      const [sonioxResult, openRouterResult] = await Promise.allSettled([
        config.soniox?.configured ? fetchSonioxSummary(sonioxApiKey()) : Promise.resolve(null),
        config.openRouter?.configured
          ? fetchOpenRouterKey(openRouterApiKey(), openRouterBaseUrl())
          : Promise.resolve(null),
      ]);
      const nextCache: ProviderCache = {
        expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
        sonioxSummary: sonioxResult.status === 'fulfilled' ? sonioxResult.value : null,
        sonioxError: sonioxResult.status === 'rejected',
        openRouterKey:
          openRouterResult.status === 'fulfilled'
            ? (openRouterResult.value as ProviderCache['openRouterKey'])
            : null,
        openRouterError: openRouterResult.status === 'rejected',
      };
      providerCache = nextCache;
      providers = providerCacheToShape(nextCache, config);
      if (nextCache.sonioxError || nextCache.openRouterError)
        logProviderEvent('warn', 'usage', 'provider_usage_unavailable', {
          requestId: newRequestId(),
          sonioxError: nextCache.sonioxError,
          openRouterError: nextCache.openRouterError,
        });
    }

    return json(
      {
        generatedAt: new Date().toISOString(),
        sessionStartedAt: new Date(sessionStartedAt).toISOString(),
        local: {
          openrouter: localFor('openrouter'),
          soniox: localFor('soniox'),
        },
        providers,
        pricing: {
          soniox: {
            inputTextPerMillion: 4,
            outputAudioPerMillion: 21.5,
          },
          openrouter: { chatModel: config.openRouter?.chatModel ?? null },
        },
      },
      config,
    );
  } catch (error) {
    logProviderEvent('error', 'usage', 'handler_error', {
      category: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return json({ error: 'Failed to load usage' }, config, { status: 500 });
  }
};

// --- helpers kept module-private ---

const bootedAt = Date.now();

const sessionStart = () => bootedAt;

const utcDayStart = (): number => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

const cacheValid = (cache: ProviderCache | null): boolean =>
  cache !== null && cache.expiresAt > Date.now();

// The services only expose a `configured` boolean; the dashboard reads the
// server keys again here to query each provider's own usage API.
const sonioxApiKey = (): string => process.env.SONIOX_API_KEY ?? '';

const openRouterApiKey = (): string => process.env.OPENROUTER_API_KEY ?? '';

const openRouterBaseUrl = (): string =>
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

const providerCacheToShape = (cache: ProviderCache, config: UsageRouteConfig) => ({
  soniox: {
    configured: Boolean(config.soniox?.configured),
    summary: cache.sonioxSummary,
    error: cache.sonioxError ? 'Provider usage is temporarily unavailable' : null,
  },
  openrouter: {
    configured: Boolean(config.openRouter?.configured),
    key: cache.openRouterKey,
    error: cache.openRouterError ? 'Provider usage is temporarily unavailable' : null,
  },
});
