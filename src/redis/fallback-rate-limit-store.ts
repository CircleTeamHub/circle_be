import { Logger } from '@nestjs/common';
import {
  MemoryStore,
  type IncrementResponse,
  type Options as RateLimitOptions,
  type Store,
} from 'express-rate-limit';

type MinimalLogger = Pick<Logger, 'warn' | 'log'>;

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
  localKeys = false;
  prefix?: string;

  private readonly memory = new MemoryStore();
  /** True while the primary store is failing and we are serving from memory. */
  private degraded = false;

  constructor(
    private readonly primary: Store,
    private readonly limiterName: string,
    private readonly logger: MinimalLogger = new Logger(
      FallbackRateLimitStore.name,
    ),
  ) {
    this.prefix = primary.prefix;
    this.localKeys = primary.localKeys ?? false;
  }

  init(options: RateLimitOptions): void {
    // Memory fallback must be initialised up front so it is ready the instant
    // the primary fails — init is not awaited and may race with increment().
    this.memory.init(options);
    try {
      this.primary.init?.(options);
    } catch (error) {
      this.logger.warn(
        `[${this.limiterName}] primary rate-limit store init failed: ${message(error)}`,
      );
    }
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      const result = await this.primary.increment(key);
      this.markRecovered();
      return result;
    } catch (error) {
      this.markDegraded(error);
      return this.memory.increment(key);
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
    if (!this.degraded) {
      this.degraded = true;
      this.logger.warn(
        `[${this.limiterName}] Redis rate-limit store unavailable; ` +
          `failing over to in-memory per-instance limiting: ${message(error)}`,
      );
    }
  }

  private markRecovered(): void {
    if (this.degraded) {
      this.degraded = false;
      this.logger.log(
        `[${this.limiterName}] Redis rate-limit store recovered; resumed shared limiting.`,
      );
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
