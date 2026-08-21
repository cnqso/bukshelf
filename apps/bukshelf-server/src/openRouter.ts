import { RateLimiter } from './rateLimit';
import {
  errorCategory,
  fingerprint,
  isAbortError,
  logProviderEvent,
  newRequestId,
} from './telemetry';
import type { UsageStore } from './usageStore';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_CHAT_MODEL = 'google/gemini-3.6-flash';
const AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  chatModel?: string;
  maxInputCharacters?: number;
  maxOutputTokens?: number;
  maxConcurrent?: number;
  requestsPerMinute?: number;
  tokensPerDay?: number;
  appReferer?: string;
  appTitle?: string;
  /** Injectable transport for deterministic failure-path tests. */
  fetchFn?: FetchFn;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequestBody {
  messages?: Array<{ role?: unknown; content?: unknown }>;
  system?: string;
  apiKey?: string;
  model?: string;
  provider?: string;
}

interface ProviderUsageChunk {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

interface UpstreamChunk {
  choices?: Array<{ delta?: { content?: unknown } }>;
  usage?: ProviderUsageChunk;
  error?: { message?: unknown };
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const createOpenRouterConfigFromEnv = (): OpenRouterConfig => ({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
  chatModel: process.env.OPENROUTER_CHAT_MODEL || undefined,
  maxInputCharacters: positiveInteger(process.env.OPENROUTER_MAX_INPUT_CHARACTERS, 900_000),
  maxOutputTokens: positiveInteger(
    process.env.OPENROUTER_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS,
  ),
  maxConcurrent: positiveInteger(process.env.OPENROUTER_MAX_CONCURRENT, 2),
  requestsPerMinute: positiveInteger(process.env.OPENROUTER_REQUESTS_PER_MINUTE, 30),
  tokensPerDay: positiveInteger(process.env.OPENROUTER_TOKENS_PER_DAY, 5_000_000),
  appReferer: process.env.SITE_URL || undefined,
  appTitle: process.env.SELF_HOSTED_BRAND_NAME
    ? `${process.env.SELF_HOSTED_BRAND_NAME} Self-Hosted`
    : undefined,
});

/** Conservative UTF-8-bytes/3 estimate; provider counts replace it when reported. */
export const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3));

const normalizeContent = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('\n');
  }
  return null;
};

const validateMessages = (body: ChatRequestBody): ChatMessage[] | string => {
  if (!Array.isArray(body.messages)) return 'Messages required';
  const messages: ChatMessage[] = [];
  for (const raw of body.messages) {
    const role = raw?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant')
      return `Unsupported message role: ${String(role)}`;
    const content = normalizeContent(raw?.content);
    if (content === null) return `Unsupported message content for role ${role}`;
    messages.push({ role, content });
  }
  if (messages.length === 0) return 'Messages required';
  return messages;
};

const jsonError = (
  error: { message: string; type?: string },
  status: number,
  headers: Record<string, string> = {},
): Response =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store', ...headers } });

const secondsUntilUtcMidnight = (now: number): number => {
  const date = new Date(now);
  const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextDay - now) / 1000));
};

/**
 * Server-managed OpenRouter chat proxy plus a passthrough for client-supplied
 * AI Gateway keys. Responses stream as plain text deltas; token usage is
 * captured from the provider's final SSE chunk and persisted by the usage
 * store. Prompt text is never logged or persisted.
 */
export class OpenRouterService {
  readonly #limiter: RateLimiter;

  constructor(
    private readonly config: OpenRouterConfig,
    private readonly usage: UsageStore,
  ) {
    this.#limiter = new RateLimiter({
      maxConcurrent: config.maxConcurrent ?? 2,
      requestsPerMinute: config.requestsPerMinute ?? 30,
    });
  }

  get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  get chatModel(): string {
    return this.config.chatModel ?? DEFAULT_CHAT_MODEL;
  }

  limits() {
    return {
      maxConcurrent: this.config.maxConcurrent ?? 2,
      requestsPerMinute: this.config.requestsPerMinute ?? 30,
      tokensPerDay: this.config.tokensPerDay ?? 5_000_000,
      maxOutputTokens: this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
  }

  snapshot(now = Date.now()) {
    return {
      model: this.chatModel,
      todayUnits: this.usage.dayUnits('openrouter', now),
      limits: this.limits(),
      activeRequests: this.#limiter.activeRequests,
    };
  }

  async handleChatPost(request: Request, ownerId: string): Promise<Response> {
    let body: ChatRequestBody;
    try {
      body = (await request.json()) as ChatRequestBody;
    } catch {
      return jsonError({ message: 'Invalid JSON body', type: 'invalid_request_error' }, 400);
    }
    const messages = validateMessages(body);
    if (typeof messages === 'string')
      return jsonError({ message: messages, type: 'invalid_request_error' }, 400);

    if (body.provider !== undefined && body.provider !== 'openrouter') {
      // Client-supplied key passthrough (Vercel AI Gateway). Metering stays on
      // the caller's own provider account, so nothing is recorded locally.
      if (!body.apiKey)
        return jsonError({ message: 'API key required', type: 'invalid_request_error' }, 401);
      return this.proxyStream({
        baseUrl: AI_GATEWAY_BASE_URL,
        apiKey: body.apiKey,
        model: body.model || 'google/gemini-2.5-flash-lite',
        messages,
        system: body.system,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        metering: null,
      });
    }

    if (!this.config.apiKey)
      return jsonError(
        { message: 'Server-managed OpenRouter is not configured', type: 'service_unavailable' },
        503,
      );

    const serializedPrompt = `${body.system ?? ''}\n${JSON.stringify(messages)}`;
    if (serializedPrompt.length > (this.config.maxInputCharacters ?? 900_000))
      return jsonError({ message: 'AI request is too large', type: 'invalid_request_error' }, 413);

    const requestId = newRequestId();
    const model = this.chatModel;
    const estimatedInputTokens = estimateTokens(serializedPrompt);
    const now = Date.now();
    const usedToday = this.usage.dayUnits('openrouter', now);
    if (usedToday + estimatedInputTokens > (this.config.tokensPerDay ?? 5_000_000)) {
      this.usage.record({
        requestId,
        provider: 'openrouter',
        operation: 'chat',
        model,
        ownerId,
        status: 'rejected',
        httpStatus: 429,
        inputUnits: estimatedInputTokens,
        unitsExact: false,
        errorCategory: 'daily_token_limit',
      });
      logProviderEvent('warn', 'openrouter_ai', 'rejected', {
        requestId,
        ownerId: fingerprint(ownerId),
        model,
        estimatedInputTokens,
        usedToday,
        reason: 'daily_token_limit',
      });
      return jsonError(
        { message: 'Reader AI usage limit reached', type: 'daily_token_limit' },
        429,
        { 'Retry-After': String(secondsUntilUtcMidnight(now)) },
      );
    }

    const grant = await this.#limiter.acquire(request.signal);
    if (!grant.accepted) {
      this.usage.record({
        requestId,
        provider: 'openrouter',
        operation: 'chat',
        model,
        ownerId,
        status: 'rejected',
        httpStatus: grant.reason === 'cancelled' ? 499 : 429,
        inputUnits: estimatedInputTokens,
        unitsExact: false,
        errorCategory: grant.reason,
      });
      return jsonError({ message: 'Reader AI request rejected', type: grant.reason }, 429);
    }

    logProviderEvent('info', 'openrouter_ai', 'started', {
      requestId,
      ownerId: fingerprint(ownerId),
      model,
      promptCharacters: serializedPrompt.length,
      promptFingerprint: fingerprint(serializedPrompt),
      estimatedInputTokens,
    });

    try {
      return await this.proxyStream({
        baseUrl: this.config.baseUrl ?? DEFAULT_BASE_URL,
        apiKey: this.config.apiKey!,
        model,
        messages,
        system: body.system ?? 'You are a helpful reading assistant.',
        maxOutputTokens: this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        metering: {
          requestId,
          ownerId,
          estimatedInputTokens,
          startedAt: Date.now(),
          release: grant.release,
        },
        extraHeaders: {
          ...(this.config.appReferer ? { 'HTTP-Referer': this.config.appReferer } : {}),
          ...(this.config.appTitle ? { 'X-Title': this.config.appTitle } : {}),
        },
        signal: request.signal,
      });
    } catch (error) {
      grant.release();
      const cancelled = isAbortError(error) || request.signal.aborted;
      this.usage.record({
        requestId,
        provider: 'openrouter',
        operation: 'chat',
        model,
        ownerId,
        status: 'failed',
        httpStatus: cancelled ? 499 : 502,
        inputUnits: estimatedInputTokens,
        unitsExact: false,
        durationMs: Date.now() - now,
        errorCategory: cancelled ? 'timeout_or_cancelled' : errorCategory(error),
      });
      logProviderEvent('error', 'openrouter_ai', 'network_error', {
        requestId,
        category: cancelled ? 'timeout_or_cancelled' : errorCategory(error),
      });
      return jsonError(
        {
          message: cancelled ? 'Reader AI request was cancelled' : 'Reader AI is unavailable',
          type: cancelled ? 'cancelled' : 'upstream_error',
        },
        cancelled ? 499 : 502,
        { 'x-request-id': requestId },
      );
    }
  }

  private async proxyStream(options: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    system?: string;
    maxOutputTokens: number;
    metering: {
      requestId: string;
      ownerId: string;
      estimatedInputTokens: number;
      startedAt: number;
      release: () => void;
    } | null;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Response> {
    const upstream = await (this.config.fetchFn ?? fetch)(
      `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          ...options.extraHeaders,
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.system
            ? [{ role: 'system', content: options.system }, ...options.messages]
            : options.messages,
          stream: true,
          max_tokens: options.maxOutputTokens,
        }),
        signal: options.signal,
      },
    );

    const requestId = options.metering?.requestId ?? newRequestId();
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.json().catch(() => null)) as UpstreamChunk | null;
      const message =
        typeof detail?.error?.message === 'string' ? detail.error.message : 'Chat request failed';
      options.metering?.release();
      if (options.metering) {
        this.usage.record({
          requestId,
          provider: 'openrouter',
          operation: 'chat',
          model: options.model,
          ownerId: options.metering.ownerId,
          status: 'failed',
          httpStatus: upstream.status,
          inputUnits: options.metering.estimatedInputTokens,
          unitsExact: false,
          durationMs: Date.now() - options.metering.startedAt,
          errorCategory: 'upstream_error',
        });
        logProviderEvent('warn', 'openrouter_ai', 'upstream_error', {
          requestId,
          status: upstream.status,
          durationMs: Date.now() - options.metering.startedAt,
        });
      }
      return jsonError(
        { message, type: 'upstream_error' },
        upstream.status >= 400 ? upstream.status : 502,
      );
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let finished = false;
    let providerUsage: ProviderUsageChunk | undefined;
    let failure: unknown;

    const finishOnce = (aborted: boolean) => {
      if (finished) return;
      finished = true;
      options.metering?.release();
      if (!options.metering) return;
      const exact = !aborted && !failure && providerUsage !== undefined;
      this.usage.record({
        requestId,
        provider: 'openrouter',
        operation: 'chat',
        model: options.model,
        ownerId: options.metering.ownerId,
        status: aborted || failure ? 'failed' : 'success',
        httpStatus: aborted ? 499 : failure ? 502 : 200,
        inputUnits: exact
          ? (providerUsage!.prompt_tokens ?? 0)
          : options.metering.estimatedInputTokens,
        outputUnits: exact ? (providerUsage!.completion_tokens ?? 0) : 0,
        totalUnits: exact
          ? (providerUsage!.total_tokens ??
            (providerUsage!.prompt_tokens ?? 0) + (providerUsage!.completion_tokens ?? 0))
          : options.metering.estimatedInputTokens,
        unitsExact: exact,
        costUsd: exact && typeof providerUsage!.cost === 'number' ? providerUsage!.cost : null,
        costSource: exact && typeof providerUsage!.cost === 'number' ? 'provider' : null,
        durationMs: Date.now() - options.metering.startedAt,
        errorCategory: failure
          ? isAbortError(failure)
            ? 'timeout_or_cancelled'
            : errorCategory(failure)
          : aborted
            ? 'timeout_or_cancelled'
            : null,
      });
      logProviderEvent('info', 'openrouter_ai', 'completed', {
        requestId,
        model: options.model,
        status: aborted ? 'cancelled' : failure ? 'failed' : 'success',
        durationMs: Date.now() - options.metering.startedAt,
        usageExact: exact,
        promptTokens: exact ? (providerUsage!.prompt_tokens ?? 0) : undefined,
        completionTokens: exact ? (providerUsage!.completion_tokens ?? 0) : undefined,
        estimatedInputTokens: exact ? undefined : options.metering.estimatedInputTokens,
        costUsd: exact && typeof providerUsage!.cost === 'number' ? providerUsage!.cost : undefined,
      });
    };

    const textStream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newlineAt = buffer.indexOf('\n');
            while (newlineAt !== -1) {
              const line = buffer.slice(0, newlineAt).trim();
              buffer = buffer.slice(newlineAt + 1);
              newlineAt = buffer.indexOf('\n');
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const chunk = JSON.parse(payload) as UpstreamChunk;
                const delta = chunk.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length > 0)
                  controller.enqueue(encoder.encode(delta));
                if (chunk.usage) providerUsage = chunk.usage;
              } catch {
                // Tolerate malformed keep-alive lines from the provider.
              }
            }
          }
          controller.close();
        } catch (error) {
          failure = error;
          controller.error(error);
        } finally {
          finishOnce(false);
        }
      },
      cancel: async () => {
        finishOnce(true);
        await reader.cancel().catch(() => {});
      },
    });

    return new Response(textStream, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
      },
    });
  }
}
