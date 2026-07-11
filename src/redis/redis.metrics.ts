import { Counter, Gauge, Registry } from 'prom-client';

export type RedisCommandOperation =
  | 'connect'
  | 'publish'
  | 'get'
  | 'set'
  | 'versioned_get'
  | 'versioned_set'
  | 'delete'
  | 'increment'
  | 'subscribe'
  | 'rate_limit';

export type RedisFailureReason = 'timeout' | 'unavailable' | 'error';

export interface RedisMetrics {
  readonly registry: Registry;
  recordCommandFailure(
    operation: RedisCommandOperation,
    reason: RedisFailureReason,
  ): void;
  recordRateLimitFallback(limiterName: string): void;
  setRateLimitDegraded(limiterName: string, degraded: boolean): void;
}

export const OTHER_LIMITER = 'other';
const MAX_LIMITER_NAMES = 50;

export function createRedisMetrics(): RedisMetrics {
  const registry = new Registry();
  const commandFailures = new Counter({
    name: 'redis_command_failures_total',
    help: 'Failed Redis operations by bounded operation and failure reason.',
    labelNames: ['operation', 'reason'],
    registers: [registry],
  });
  const rateLimitFallbacks = new Counter({
    name: 'redis_rate_limit_fallback_total',
    help: 'Rate-limit requests served by per-instance memory after Redis failed.',
    labelNames: ['limiter'],
    registers: [registry],
  });
  const rateLimitDegraded = new Gauge({
    name: 'redis_rate_limit_degraded',
    help: 'Whether a rate limiter is currently using its memory fallback.',
    labelNames: ['limiter'],
    registers: [registry],
  });
  const rateLimitTransitions = new Counter({
    name: 'redis_rate_limit_transitions_total',
    help: 'Rate-limit store transitions into and out of degraded mode.',
    labelNames: ['limiter', 'state'],
    registers: [registry],
  });

  const seenLimiters = new Set<string>();
  const boundedLimiterName = (limiterName: string): string => {
    if (seenLimiters.has(limiterName)) return limiterName;
    if (seenLimiters.size >= MAX_LIMITER_NAMES) return OTHER_LIMITER;
    seenLimiters.add(limiterName);
    return limiterName;
  };

  return {
    registry,
    recordCommandFailure(operation, reason) {
      commandFailures.inc({ operation, reason });
    },
    recordRateLimitFallback(limiterName) {
      rateLimitFallbacks.inc({ limiter: boundedLimiterName(limiterName) });
    },
    setRateLimitDegraded(limiterName, degraded) {
      const limiter = boundedLimiterName(limiterName);
      rateLimitDegraded.set({ limiter }, degraded ? 1 : 0);
      rateLimitTransitions.inc({
        limiter,
        state: degraded ? 'degraded' : 'recovered',
      });
    },
  };
}

export const redisMetrics = createRedisMetrics();
