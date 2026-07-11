import { createRedisMetrics, OTHER_LIMITER } from './redis.metrics';

describe('createRedisMetrics', () => {
  it('records Redis failures without dynamic keys or error messages', async () => {
    const metrics = createRedisMetrics();

    metrics.recordCommandFailure('get', 'timeout');
    metrics.recordCommandFailure('get', 'timeout');
    metrics.recordCommandFailure('rate_limit', 'unavailable');

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /redis_command_failures_total\{operation="get",reason="timeout"\}\s+2/,
    );
    expect(output).toMatch(
      /redis_command_failures_total\{operation="rate_limit",reason="unavailable"\}\s+1/,
    );
  });

  it('tracks fallback requests, degraded state, and transitions', async () => {
    const metrics = createRedisMetrics();

    metrics.recordRateLimitFallback('auth_login');
    metrics.setRateLimitDegraded('auth_login', true);
    metrics.setRateLimitDegraded('auth_login', false);

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /redis_rate_limit_fallback_total\{limiter="auth_login"\}\s+1/,
    );
    expect(output).toMatch(
      /redis_rate_limit_degraded\{limiter="auth_login"\}\s+0/,
    );
    expect(output).toMatch(
      /redis_rate_limit_transitions_total\{limiter="auth_login",state="degraded"\}\s+1/,
    );
    expect(output).toMatch(
      /redis_rate_limit_transitions_total\{limiter="auth_login",state="recovered"\}\s+1/,
    );
  });

  it('bounds limiter-name cardinality', async () => {
    const metrics = createRedisMetrics();

    for (let index = 0; index < 200; index += 1) {
      metrics.recordRateLimitFallback(`dynamic-${index}`);
    }

    const output = await metrics.registry.metrics();
    const limiters = new Set(
      [
        ...output.matchAll(
          /redis_rate_limit_fallback_total\{limiter="([^"]+)"/g,
        ),
      ].map((match) => match[1]),
    );
    expect(limiters.size).toBeLessThanOrEqual(51);
    expect(limiters.has(OTHER_LIMITER)).toBe(true);
  });
});
