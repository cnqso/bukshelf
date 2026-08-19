export interface OpenRouterUsageSnapshot {
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
  day: string;
}

interface Lease {
  estimatedInputTokens: number;
}

const numberFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class OpenRouterUsageMeter {
  #day = new Date().toISOString().slice(0, 10);
  #activeRequests = 0;
  #requestTimes: number[] = [];
  #estimatedInputTokensToday = 0;
  #actualInputTokensToday = 0;
  #actualOutputTokensToday = 0;
  #actualTotalTokensToday = 0;
  #rejectedRequestsToday = 0;
  #totalRequestsToday = 0;

  acquire(estimatedInputTokens: number):
    | { accepted: true; lease: Lease; snapshot: OpenRouterUsageSnapshot }
    | {
        accepted: false;
        reason: string;
        retryAfterSeconds: number;
        snapshot: OpenRouterUsageSnapshot;
      } {
    const now = Date.now();
    this.#rollDay(now);
    this.#requestTimes = this.#requestTimes.filter((time) => time > now - 60_000);

    const maxConcurrent = numberFromEnv('OPENROUTER_MAX_CONCURRENT', 2);
    const requestsPerMinute = numberFromEnv('OPENROUTER_REQUESTS_PER_MINUTE', 30);
    const tokensPerDay = numberFromEnv('OPENROUTER_TOKENS_PER_DAY', 250_000);
    let reason: string | null = null;
    let retryAfterSeconds = 1;
    if (this.#activeRequests >= maxConcurrent) {
      reason = 'concurrency_limit';
    } else if (this.#requestTimes.length >= requestsPerMinute) {
      reason = 'request_rate_limit';
      retryAfterSeconds = Math.max(1, Math.ceil((this.#requestTimes[0]! + 60_000 - now) / 1000));
    } else if (this.#estimatedInputTokensToday + estimatedInputTokens > tokensPerDay) {
      reason = 'daily_token_limit';
      retryAfterSeconds = Math.max(
        1,
        Math.ceil((new Date(`${this.#day}T00:00:00.000Z`).getTime() + 86_400_000 - now) / 1000),
      );
    }

    if (reason) {
      this.#rejectedRequestsToday += 1;
      return { accepted: false, reason, retryAfterSeconds, snapshot: this.snapshot() };
    }
    this.#activeRequests += 1;
    this.#requestTimes.push(now);
    this.#totalRequestsToday += 1;
    this.#estimatedInputTokensToday += estimatedInputTokens;
    return { accepted: true, lease: { estimatedInputTokens }, snapshot: this.snapshot() };
  }

  finish(
    lease: Lease,
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
  ): OpenRouterUsageSnapshot {
    this.#rollDay(Date.now());
    this.#activeRequests = Math.max(0, this.#activeRequests - 1);
    if (usage) {
      this.#estimatedInputTokensToday = Math.max(
        0,
        this.#estimatedInputTokensToday - lease.estimatedInputTokens,
      );
      this.#actualInputTokensToday += usage.inputTokens ?? 0;
      this.#actualOutputTokensToday += usage.outputTokens ?? 0;
      this.#actualTotalTokensToday +=
        usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
    return this.snapshot();
  }

  snapshot(): OpenRouterUsageSnapshot {
    this.#rollDay(Date.now());
    const now = Date.now();
    this.#requestTimes = this.#requestTimes.filter((time) => time > now - 60_000);
    return {
      activeRequests: this.#activeRequests,
      requestsLastMinute: this.#requestTimes.length,
      estimatedInputTokensToday: this.#estimatedInputTokensToday,
      actualInputTokensToday: this.#actualInputTokensToday,
      actualOutputTokensToday: this.#actualOutputTokensToday,
      actualTotalTokensToday: this.#actualTotalTokensToday,
      rejectedRequestsToday: this.#rejectedRequestsToday,
      totalRequestsToday: this.#totalRequestsToday,
      limits: {
        maxConcurrent: numberFromEnv('OPENROUTER_MAX_CONCURRENT', 2),
        requestsPerMinute: numberFromEnv('OPENROUTER_REQUESTS_PER_MINUTE', 30),
        tokensPerDay: numberFromEnv('OPENROUTER_TOKENS_PER_DAY', 250_000),
        maxOutputTokens: numberFromEnv('OPENROUTER_MAX_OUTPUT_TOKENS', 2_048),
      },
      day: this.#day,
    };
  }

  #rollDay(now: number) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day === this.#day) return;
    this.#day = day;
    this.#estimatedInputTokensToday = 0;
    this.#actualInputTokensToday = 0;
    this.#actualOutputTokensToday = 0;
    this.#actualTotalTokensToday = 0;
    this.#rejectedRequestsToday = 0;
    this.#totalRequestsToday = 0;
  }
}

export const estimateOpenRouterTokens = (text: string): number =>
  Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 3));

export const openRouterUsageMeter = new OpenRouterUsageMeter();
