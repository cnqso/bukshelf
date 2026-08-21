import { openRouterUsageMeter } from '@/services/ai/openRouterUsageMeter';
import { sonioxUsageMeter } from '@/services/tts/sonioxUsageMeter';
import { validateUserAndToken } from '@/utils/access';

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

interface SonioxSummaryResponse {
  models?: SonioxUsageEntry[];
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

interface ProviderUsageCache {
  expiresAt: number;
  sonioxSummary: SonioxUsageEntry | null;
  sonioxError: boolean;
  openRouterKey: Awaited<ReturnType<typeof fetchOpenRouterUsage>> | null;
  openRouterError: boolean;
}

let providerUsageCache: ProviderUsageCache | null = null;

const utcMidnight = (offsetDays: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays),
  ).toISOString();
};

const fetchSonioxUsage = async (apiKey: string) => {
  const url = new URL('https://api.soniox.com/v1/usage/summary');
  url.searchParams.set('start_time', utcMidnight(-6));
  url.searchParams.set('end_time', utcMidnight(1));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Soniox usage API returned ${response.status}`);
  const data = (await response.json()) as SonioxSummaryResponse;
  return data.models?.find((entry) => entry.model === 'tts-rt-v2') ?? null;
};

const fetchOpenRouterUsage = async (apiKey: string) => {
  const baseUrl = (process.env['OPENROUTER_BASE_URL'] || 'https://openrouter.ai/api/v1').replace(
    /\/+$/,
    '',
  );
  const response = await fetch(`${baseUrl}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
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

const getProviderUsage = async (sonioxKey?: string, openRouterKey?: string) => {
  if (providerUsageCache && providerUsageCache.expiresAt > Date.now()) return providerUsageCache;
  const [sonioxResult, openRouterResult] = await Promise.allSettled([
    sonioxKey ? fetchSonioxUsage(sonioxKey) : Promise.resolve(null),
    openRouterKey ? fetchOpenRouterUsage(openRouterKey) : Promise.resolve(null),
  ]);
  providerUsageCache = {
    expiresAt: Date.now() + 15_000,
    sonioxSummary: sonioxResult.status === 'fulfilled' ? sonioxResult.value : null,
    sonioxError: sonioxResult.status === 'rejected',
    openRouterKey: openRouterResult.status === 'fulfilled' ? openRouterResult.value : null,
    openRouterError: openRouterResult.status === 'rejected',
  };
  return providerUsageCache;
};

export async function GET(req: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(req.headers.get('authorization'));
  if (!user || !token) return Response.json({ error: 'Not authenticated' }, { status: 403 });

  const sonioxKey = process.env['SONIOX_API_KEY'];
  const openRouterKey = process.env['OPENROUTER_API_KEY'];
  const providerUsage = await getProviderUsage(sonioxKey, openRouterKey);

  return Response.json({
    generatedAt: new Date().toISOString(),
    local: {
      soniox: sonioxUsageMeter.snapshot(),
      openrouter: openRouterUsageMeter.snapshot(),
    },
    providers: {
      soniox: {
        configured: Boolean(sonioxKey),
        summary: providerUsage.sonioxSummary,
        error: providerUsage.sonioxError ? 'Provider usage is temporarily unavailable' : null,
      },
      openrouter: {
        configured: Boolean(openRouterKey),
        key: providerUsage.openRouterKey,
        error: providerUsage.openRouterError ? 'Provider usage is temporarily unavailable' : null,
      },
    },
    pricing: {
      soniox: {
        inputTextPerMillion: 4,
        outputAudioPerMillion: 21.5,
        approximatePerAudioHour: 0.7,
      },
      openrouter: {
        chatModel: process.env['OPENROUTER_CHAT_MODEL'] || 'google/gemini-3.6-flash',
      },
    },
  });
}
