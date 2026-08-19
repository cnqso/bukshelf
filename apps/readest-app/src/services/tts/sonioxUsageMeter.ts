export interface SonioxUsageLimits {
  maxConcurrent: number;
  maxQueueSize: number;
  maxRequestsPerMinute: number;
  maxTokensPerMinutePerUser: number;
  maxTokensPerDay: number;
}

export interface SonioxUsageLease {
  id: number;
  userId: string;
  characters: number;
  estimatedTokens: number;
  queuedAt: number;
  acceptedAt: number;
}

type SonioxUsageInput = Pick<SonioxUsageLease, 'userId' | 'characters' | 'estimatedTokens'>;
type SonioxRejectionReason =
  | 'queue_limit'
  | 'request_cancelled'
  | 'request_rate_limit'
  | 'user_token_limit'
  | 'daily_token_limit';

export type SonioxMeterResult =
  | { accepted: true; lease: SonioxUsageLease; snapshot: SonioxUsageSnapshot }
  | {
      accepted: false;
      reason: SonioxRejectionReason;
      retryAfterSeconds: number;
      snapshot: SonioxUsageSnapshot;
    };

export interface SonioxUsageSnapshot {
  activeRequests: number;
  queuedRequests: number;
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

interface QueuedUsage {
  usage: SonioxUsageInput;
  signal?: AbortSignal;
  queuedAt: number;
  resolve: (result: SonioxMeterResult) => void;
  abortHandler?: () => void;
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
  readonly #queue: QueuedUsage[] = [];
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

  async acquire(
    usage: SonioxUsageInput,
    signal?: AbortSignal,
    now = Date.now(),
  ): Promise<SonioxMeterResult> {
    this.#rollWindows(now);
    if (signal?.aborted) return this.#reject('request_cancelled', 0, now);
    const limited = this.#checkUsageLimits(usage, now);
    if (limited) return limited;
    if (this.#activeRequests < this.#limits.maxConcurrent) {
      return this.#accept(usage, now, now);
    }
    if (this.#queue.length >= this.#limits.maxQueueSize) {
      return this.#reject('queue_limit', 1, now);
    }

    return new Promise<SonioxMeterResult>((resolve) => {
      const queued: QueuedUsage = { usage, signal, queuedAt: now, resolve };
      if (signal) {
        queued.abortHandler = () => {
          const index = this.#queue.indexOf(queued);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          resolve(this.#reject('request_cancelled', 0));
        };
        signal.addEventListener('abort', queued.abortHandler, { once: true });
      }
      this.#queue.push(queued);
      // Abort can race between the initial check and listener registration.
      if (signal?.aborted) queued.abortHandler?.();
    });
  }

  #accept(usage: SonioxUsageInput, queuedAt: number, now: number): SonioxMeterResult {
    const minute = this.#getUserMinute(usage.userId, now);

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
      queuedAt,
      acceptedAt: now,
    };
    this.#activeLeaseIds.add(lease.id);
    return { accepted: true, lease, snapshot: this.snapshot(now) };
  }

  finish(lease: SonioxUsageLease): void {
    if (!this.#activeLeaseIds.delete(lease.id)) return;
    this.#activeRequests = Math.max(0, this.#activeRequests - 1);
    this.#drainQueue();
  }

  snapshot(now = Date.now()): SonioxUsageSnapshot {
    this.#rollWindows(now);
    return {
      activeRequests: this.#activeRequests,
      queuedRequests: this.#queue.length,
      totalRequests: this.#totalRequests,
      totalCharacters: this.#totalCharacters,
      totalEstimatedTokens: this.#totalEstimatedTokens,
      dailyEstimatedTokens: this.#dailyEstimatedTokens,
      minuteRequests: this.#minuteRequests,
      limits: { ...this.#limits },
    };
  }

  #reject(reason: SonioxRejectionReason, retryAfterSeconds: number, now = Date.now()) {
    return {
      accepted: false as const,
      reason,
      retryAfterSeconds,
      snapshot: this.snapshot(now),
    };
  }

  #checkUsageLimits(usage: SonioxUsageInput, now: number): SonioxMeterResult | null {
    const minute = this.#getUserMinute(usage.userId, now);
    if (this.#minuteRequests >= this.#limits.maxRequestsPerMinute) {
      return this.#reject(
        'request_rate_limit',
        secondsUntil(this.#minuteStartedAt + 60_000, now),
        now,
      );
    }
    if (minute.estimatedTokens + usage.estimatedTokens > this.#limits.maxTokensPerMinutePerUser) {
      return this.#reject('user_token_limit', secondsUntil(minute.startedAt + 60_000, now), now);
    }
    if (this.#dailyEstimatedTokens + usage.estimatedTokens > this.#limits.maxTokensPerDay) {
      return this.#reject(
        'daily_token_limit',
        secondsUntil(this.#dayStartedAt + 24 * 60 * 60 * 1000, now),
        now,
      );
    }
    return null;
  }

  #drainQueue(now = Date.now()): void {
    this.#rollWindows(now);
    while (this.#activeRequests < this.#limits.maxConcurrent && this.#queue.length > 0) {
      const queued = this.#queue.shift()!;
      if (queued.abortHandler && queued.signal) {
        queued.signal.removeEventListener('abort', queued.abortHandler);
      }
      if (queued.signal?.aborted) {
        queued.resolve(this.#reject('request_cancelled', 0, now));
        continue;
      }
      const limited = this.#checkUsageLimits(queued.usage, now);
      queued.resolve(limited ?? this.#accept(queued.usage, queued.queuedAt, now));
    }
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
  maxQueueSize: positiveInteger(process.env['SONIOX_TTS_MAX_QUEUE_SIZE'], 32),
  maxRequestsPerMinute: positiveInteger(process.env['SONIOX_TTS_REQUESTS_PER_MINUTE'], 90),
  maxTokensPerMinutePerUser: positiveInteger(
    process.env['SONIOX_TTS_TOKENS_PER_MINUTE_PER_USER'],
    20_000,
  ),
  maxTokensPerDay: positiveInteger(process.env['SONIOX_TTS_TOKENS_PER_DAY'], 500_000),
});
