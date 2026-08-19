export interface SonioxUsageLimits {
  maxConcurrent: number;
  maxRequestsPerMinute: number;
  maxTokensPerMinutePerUser: number;
  maxTokensPerDay: number;
}

export interface SonioxUsageLease {
  id: number;
  userId: string;
  characters: number;
  estimatedTokens: number;
  acceptedAt: number;
}

export type SonioxMeterResult =
  | { accepted: true; lease: SonioxUsageLease; snapshot: SonioxUsageSnapshot }
  | {
      accepted: false;
      reason: 'concurrency_limit' | 'request_rate_limit' | 'user_token_limit' | 'daily_token_limit';
      retryAfterSeconds: number;
      snapshot: SonioxUsageSnapshot;
    };

export interface SonioxUsageSnapshot {
  activeRequests: number;
  totalRequests: number;
  totalCharacters: number;
  totalEstimatedTokens: number;
  dailyEstimatedTokens: number;
  minuteRequests: number;
  limits: SonioxUsageLimits;
}

interface UserMinuteUsage {
  startedAt: number;
  estimatedTokens: number;
}

// Soniox exposes exact model token usage in its own usage logs, not in the
// synthesis response. UTF-8 bytes / 3 is deliberately conservative for Latin
// text while remaining roughly one token per CJK character.
export const estimateSonioxTokens = (text: string): number =>
  Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3));

const secondsUntil = (timestamp: number, now: number) =>
  Math.max(1, Math.ceil((timestamp - now) / 1000));

export class SonioxUsageMeter {
  readonly #limits: SonioxUsageLimits;
  readonly #userMinuteUsage = new Map<string, UserMinuteUsage>();
  readonly #activeLeaseIds = new Set<number>();
  #nextLeaseId = 1;
  #activeRequests = 0;
  #totalRequests = 0;
  #totalCharacters = 0;
  #totalEstimatedTokens = 0;
  #dailyEstimatedTokens = 0;
  #dayStartedAt: number;
  #minuteStartedAt: number;
  #minuteRequests = 0;

  constructor(limits: SonioxUsageLimits, now = Date.now()) {
    this.#limits = limits;
    this.#dayStartedAt = this.#startOfUtcDay(now);
    this.#minuteStartedAt = now;
  }

  begin(
    usage: { userId: string; characters: number; estimatedTokens: number },
    now = Date.now(),
  ): SonioxMeterResult {
    this.#rollWindows(now);
    const minute = this.#getUserMinute(usage.userId, now);

    if (this.#activeRequests >= this.#limits.maxConcurrent) {
      return this.#reject('concurrency_limit', 1);
    }
    if (this.#minuteRequests >= this.#limits.maxRequestsPerMinute) {
      return this.#reject('request_rate_limit', secondsUntil(this.#minuteStartedAt + 60_000, now));
    }
    if (minute.estimatedTokens + usage.estimatedTokens > this.#limits.maxTokensPerMinutePerUser) {
      return this.#reject('user_token_limit', secondsUntil(minute.startedAt + 60_000, now));
    }
    if (this.#dailyEstimatedTokens + usage.estimatedTokens > this.#limits.maxTokensPerDay) {
      return this.#reject(
        'daily_token_limit',
        secondsUntil(this.#dayStartedAt + 24 * 60 * 60 * 1000, now),
      );
    }

    minute.estimatedTokens += usage.estimatedTokens;
    this.#minuteRequests += 1;
    this.#activeRequests += 1;
    this.#totalRequests += 1;
    this.#totalCharacters += usage.characters;
    this.#totalEstimatedTokens += usage.estimatedTokens;
    this.#dailyEstimatedTokens += usage.estimatedTokens;

    const lease: SonioxUsageLease = {
      id: this.#nextLeaseId++,
      ...usage,
      acceptedAt: now,
    };
    this.#activeLeaseIds.add(lease.id);
    return { accepted: true, lease, snapshot: this.snapshot(now) };
  }

  finish(lease: SonioxUsageLease): void {
    if (!this.#activeLeaseIds.delete(lease.id)) return;
    this.#activeRequests = Math.max(0, this.#activeRequests - 1);
  }

  snapshot(now = Date.now()): SonioxUsageSnapshot {
    this.#rollWindows(now);
    return {
      activeRequests: this.#activeRequests,
      totalRequests: this.#totalRequests,
      totalCharacters: this.#totalCharacters,
      totalEstimatedTokens: this.#totalEstimatedTokens,
      dailyEstimatedTokens: this.#dailyEstimatedTokens,
      minuteRequests: this.#minuteRequests,
      limits: { ...this.#limits },
    };
  }

  #reject(
    reason: Exclude<SonioxMeterResult, { accepted: true }>['reason'],
    retryAfterSeconds: number,
  ) {
    return {
      accepted: false as const,
      reason,
      retryAfterSeconds,
      snapshot: this.snapshot(),
    };
  }

  #getUserMinute(userId: string, now: number): UserMinuteUsage {
    const current = this.#userMinuteUsage.get(userId);
    if (current && now - current.startedAt < 60_000) return current;
    const next = { startedAt: now, estimatedTokens: 0 };
    this.#userMinuteUsage.set(userId, next);
    return next;
  }

  #rollWindows(now: number): void {
    if (now - this.#minuteStartedAt >= 60_000) {
      this.#minuteStartedAt = now;
      this.#minuteRequests = 0;
    }
    const dayStartedAt = this.#startOfUtcDay(now);
    if (dayStartedAt !== this.#dayStartedAt) {
      this.#dayStartedAt = dayStartedAt;
      this.#dailyEstimatedTokens = 0;
    }
    for (const [userId, usage] of this.#userMinuteUsage) {
      if (now - usage.startedAt >= 60_000) this.#userMinuteUsage.delete(userId);
    }
  }

  #startOfUtcDay(now: number): number {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const sonioxUsageMeter = new SonioxUsageMeter({
  // Soniox defaults to three concurrent TTS streams. Stay below that ceiling
  // so other uses of the same project still have headroom.
  maxConcurrent: positiveInteger(process.env['SONIOX_TTS_MAX_CONCURRENT'], 2),
  maxRequestsPerMinute: positiveInteger(process.env['SONIOX_TTS_REQUESTS_PER_MINUTE'], 90),
  maxTokensPerMinutePerUser: positiveInteger(
    process.env['SONIOX_TTS_TOKENS_PER_MINUTE_PER_USER'],
    20_000,
  ),
  maxTokensPerDay: positiveInteger(process.env['SONIOX_TTS_TOKENS_PER_DAY'], 500_000),
});
