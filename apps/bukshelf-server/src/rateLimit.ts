export interface RateLimiterOptions {
  maxConcurrent: number;
  /** Maximum queued waiters when all slots are busy; 0 rejects instead of queuing. */
  maxQueueSize?: number;
  requestsPerMinute?: number;
}

export interface RateLimitRejection {
  accepted: false;
  reason: 'cancelled' | 'queue_limit' | 'request_rate_limit';
  retryAfterSeconds: number;
}

export interface RateLimitGrant {
  accepted: true;
  /** Milliseconds spent waiting in the queue before a slot opened. */
  queuedMs: number;
  release: () => void;
}

export type RateLimitDecision = RateLimitGrant | RateLimitRejection;

interface QueuedRequest {
  enqueuedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (decision: RateLimitDecision) => void;
}

const secondsUntil = (timestamp: number, now: number) =>
  Math.max(1, Math.ceil((timestamp - now) / 1000));

/**
 * In-process concurrency and per-minute rate limiting with an abortable
 * waiting queue. Daily token budgets are deliberately not handled here:
 * they must survive restarts, so callers check them against SQLite.
 */
export class RateLimiter {
  readonly #maxConcurrent: number;
  readonly #maxQueueSize: number;
  readonly #requestsPerMinute: number | null;
  readonly #requestTimes: number[] = [];
  readonly #queue: QueuedRequest[] = [];
  #activeRequests = 0;

  constructor(options: RateLimiterOptions) {
    this.#maxConcurrent = Math.max(1, options.maxConcurrent);
    this.#maxQueueSize = Math.max(0, options.maxQueueSize ?? 0);
    this.#requestsPerMinute =
      options.requestsPerMinute && options.requestsPerMinute > 0 ? options.requestsPerMinute : null;
  }

  get activeRequests(): number {
    return this.#activeRequests;
  }

  get queuedRequests(): number {
    return this.#queue.length;
  }

  requestsLastMinute(now = Date.now()): number {
    return this.#recentTimes(now).length;
  }

  snapshot(now = Date.now()): {
    activeRequests: number;
    queuedRequests: number;
    requestsLastMinute: number;
  } {
    return {
      activeRequests: this.#activeRequests,
      queuedRequests: this.#queue.length,
      requestsLastMinute: this.requestsLastMinute(now),
    };
  }

  async acquire(signal?: AbortSignal, now = Date.now()): Promise<RateLimitDecision> {
    const recent = this.#recentTimes(now);
    if (this.#requestsPerMinute !== null && recent.length >= this.#requestsPerMinute) {
      const oldest = recent[0]!;
      return {
        accepted: false,
        reason: 'request_rate_limit',
        retryAfterSeconds: secondsUntil(oldest + 60_000, now),
      };
    }
    if (signal?.aborted) return { accepted: false, reason: 'cancelled', retryAfterSeconds: 0 };
    if (this.#activeRequests < this.#maxConcurrent) return this.#grant(now, now);

    if (this.#queue.length >= this.#maxQueueSize)
      return { accepted: false, reason: 'queue_limit', retryAfterSeconds: 1 };

    return new Promise<RateLimitDecision>((resolve) => {
      const queued: QueuedRequest = { enqueuedAt: now, signal, resolve };
      if (signal) {
        queued.onAbort = () => {
          const index = this.#queue.indexOf(queued);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          resolve({ accepted: false, reason: 'cancelled', retryAfterSeconds: 0 });
        };
        signal.addEventListener('abort', queued.onAbort, { once: true });
      }
      this.#queue.push(queued);
      // Abort can race between the initial check and listener registration.
      if (signal?.aborted) queued.onAbort?.();
    });
  }

  #grant(enqueuedAt: number, timestamp: number): RateLimitGrant {
    this.#requestTimes.push(timestamp);
    this.#activeRequests += 1;
    let released = false;
    return {
      accepted: true,
      queuedMs: Math.max(0, Date.now() - enqueuedAt),
      release: () => {
        if (released) return;
        released = true;
        this.#activeRequests = Math.max(0, this.#activeRequests - 1);
        this.#drain();
      },
    };
  }

  #drain(now = Date.now()): void {
    while (this.#activeRequests < this.#maxConcurrent && this.#queue.length > 0) {
      const queued = this.#queue.shift()!;
      if (queued.signal?.aborted) continue;
      const recent = this.#recentTimes(now);
      if (this.#requestsPerMinute !== null && recent.length >= this.#requestsPerMinute) {
        const oldest = recent[0] ?? now;
        queued.resolve({
          accepted: false,
          reason: 'request_rate_limit',
          retryAfterSeconds: secondsUntil(oldest + 60_000, now),
        });
        continue;
      }
      queued.resolve(this.#grant(queued.enqueuedAt, now));
    }
  }

  #recentTimes(now: number): number[] {
    while (this.#requestTimes.length > 0 && this.#requestTimes[0]! <= now - 60_000) {
      this.#requestTimes.shift();
    }
    return this.#requestTimes;
  }
}
