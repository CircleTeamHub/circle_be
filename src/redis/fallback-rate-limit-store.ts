import { Logger } from '@nestjs/common';
import {
  MemoryStore,
  type IncrementResponse,
  type Options as RateLimitOptions,
  type Store,
} from 'express-rate-limit';
import { redisMetrics, type RedisMetrics } from './redis.metrics';

type MinimalLogger = Pick<Logger, 'warn' | 'log'>;
type RateLimitMetrics = Pick<
  RedisMetrics,
  'recordRateLimitFallback' | 'setRateLimitDegraded'
>;

/**
 * Wraps a primary (Redis-backed) rate-limit {@link Store} and transparently
 * fails over to an in-process {@link MemoryStore} whenever the primary throws —
 * e.g. during a Redis outage, failover, or reconnect window.
 *
 * Why this exists: binding a limiter to a Redis store with
 * `passOnStoreError: true` means a Redis outage SILENTLY DISABLES rate limiting
 * (express-rate-limit just calls `next()` on a store error). For auth / login /
 * registration / account-enumeration limiters that is a fail-OPEN security hole
 * — exactly when an attacker could exploit it. This wrapper instead degrades to
 * per-instance in-memory limiting, so protection stays ACTIVE (weaker, but never
 * absent) and the whole site does not 503 the way a blanket fail-closed would.
 */
export class FallbackRateLimitStore implements Store {
  private static readonly PRIMARY_RETRY_COOLDOWN_MS = 2_000;
  private static readonly MAX_PRIMARY_IN_FLIGHT = 32;

  localKeys = false;
  prefix?: string;

  private readonly memory = new MemoryStore();
  /** True while the primary store is failing and we are serving from memory. */
  private degraded = false;
  private nextPrimaryProbeAt = 0;
  private primaryProbeInFlight = false;
  private initializationPending = false;
  private primaryInFlight = 0;
  private windowMs = 60_000;

  constructor(
    private readonly primary: Store,
    private readonly limiterName: string,
    private readonly logger: MinimalLogger = new Logger(
      FallbackRateLimitStore.name,
    ),
    private readonly metrics: RateLimitMetrics = redisMetrics,
  ) {
    this.prefix = primary.prefix;
    this.localKeys = primary.localKeys ?? false;
  }

  init(options: RateLimitOptions): void {
    this.windowMs = options.windowMs;
    // Memory fallback must be initialised up front so it is ready the instant
    // the primary fails — init is not awaited and may race with increment().
    this.memory.init(options);
    try {
      const initialization = this.primary.init?.(options);
      if (
        initialization &&
        typeof (initialization as any).then === 'function'
      ) {
        this.initializationPending = true;
        this.beginInitializationFallback();
        void Promise.resolve(initialization).then(
          () => {
            this.initializationPending = false;
            this.finishInitializationFallback();
          },
          (error) => {
            this.initializationPending = false;
            this.failInitialization(error);
          },
        );
      }
    } catch (error) {
      this.initializationPending = false;
      this.markDegraded(error);
    }
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (this.initializationPending) {
      return this.incrementFallback(key);
    }
    if (this.primaryInFlight >= FallbackRateLimitStore.MAX_PRIMARY_IN_FLIGHT) {
      return Promise.resolve({
        totalHits: Number.MAX_SAFE_INTEGER,
        resetTime: new Date(Date.now() + this.windowMs),
      });
    }

    let ownsRecoveryProbe = false;
    if (this.degraded) {
      if (Date.now() < this.nextPrimaryProbeAt || this.primaryProbeInFlight) {
        return this.incrementFallback(key);
      }
      this.primaryProbeInFlight = true;
      ownsRecoveryProbe = true;
    }

    try {
      this.primaryInFlight += 1;
      const result = await this.primary.increment(key);
      if (ownsRecoveryProbe) {
        this.markRecovered();
      }
      return result;
    } catch (error) {
      this.markDegraded(error);
      return this.incrementFallback(key);
    } finally {
      this.primaryInFlight -= 1;
      if (ownsRecoveryProbe) {
        this.primaryProbeInFlight = false;
      }
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.primary.decrement(key);
    } catch {
      await this.memory.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    await Promise.allSettled([
      Promise.resolve(this.primary.resetKey(key)),
      Promise.resolve(this.memory.resetKey(key)),
    ]);
  }

  async resetAll(): Promise<void> {
    await Promise.allSettled([
      Promise.resolve(this.primary.resetAll?.()),
      Promise.resolve(this.memory.resetAll?.()),
    ]);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([
      Promise.resolve(this.primary.shutdown?.()),
      Promise.resolve(this.memory.shutdown?.()),
    ]);
  }

  private markDegraded(error: unknown): void {
    this.nextPrimaryProbeAt =
      Date.now() + FallbackRateLimitStore.PRIMARY_RETRY_COOLDOWN_MS;
    if (!this.degraded) {
      this.degraded = true;
      this.metrics.setRateLimitDegraded(this.limiterName, true);
      this.logger.warn(
        `[${this.limiterName}] Redis rate-limit store unavailable; ` +
          `failing over to in-memory per-instance limiting: ${message(error)}`,
      );
    }
  }

  private beginInitializationFallback(): void {
    if (!this.degraded) {
      this.degraded = true;
      this.metrics.setRateLimitDegraded(this.limiterName, true);
    }
  }

  private finishInitializationFallback(): void {
    if (this.degraded) {
      this.degraded = false;
      this.nextPrimaryProbeAt = 0;
      this.metrics.setRateLimitDegraded(this.limiterName, false);
    }
  }

  private failInitialization(error: unknown): void {
    this.nextPrimaryProbeAt =
      Date.now() + FallbackRateLimitStore.PRIMARY_RETRY_COOLDOWN_MS;
    if (!this.degraded) {
      this.markDegraded(error);
      return;
    }
    this.logger.warn(
      `[${this.limiterName}] primary rate-limit store init failed; ` +
        `using in-memory per-instance limiting: ${message(error)}`,
    );
  }

  private markRecovered(): void {
    if (this.degraded) {
      this.degraded = false;
      this.metrics.setRateLimitDegraded(this.limiterName, false);
      this.logger.log(
        `[${this.limiterName}] Redis rate-limit store recovered; resumed shared limiting.`,
      );
    }
    this.nextPrimaryProbeAt = 0;
  }

  private incrementFallback(key: string): Promise<IncrementResponse> {
    this.metrics.recordRateLimitFallback(this.limiterName);
    return this.memory.increment(key);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
