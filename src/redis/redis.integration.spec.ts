import type { Options } from 'express-rate-limit';
import Redis from 'ioredis';
import { redisMetrics } from './redis.metrics';
import { RedisService } from './redis.service';

const redisUrl = process.env.REDIS_TEST_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('RedisService real Redis integration', () => {
  const prefix = `integration:${process.pid}:${Date.now()}`;
  let service: RedisService;
  let admin: Redis;

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl;
    process.env.REDIS_REQUIRED = 'true';
    process.env.NODE_ENV = 'test';
    service = new RedisService();
    admin = new Redis(redisUrl!);
    await service.onModuleInit();
  });

  afterAll(async () => {
    await admin.del(...(await admin.keys(`${prefix}:*`)));
    await service.onModuleDestroy();
    await admin.quit();
  });

  it('connects with authentication and performs JSON round trips', async () => {
    expect(await admin.ping()).toBe('PONG');
    expect(await service.setJson(`${prefix}:json`, { ok: true }, 30)).toBe(
      true,
    );
    await expect(service.getJson(`${prefix}:json`)).resolves.toEqual({
      ok: true,
    });
  });

  it('increments atomically under concurrency and expires the key', async () => {
    const key = `${prefix}:counter`;
    const counts = await Promise.all(
      Array.from({ length: 40 }, () => service.incrementWithTtl(key, 1)),
    );

    expect(new Set(counts).size).toBe(40);
    expect(Math.max(...(counts as number[]))).toBe(40);
    expect(await admin.ttl(key)).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await admin.exists(key)).toBe(0);
  });

  it('enforces monotonic CAS and a non-reusable invalidation fence', async () => {
    const casKey = `${prefix}:cas`;
    expect(await service.setJsonIfNewer(casKey, 'new', 20, 30)).toBe(true);
    expect(await service.setJsonIfNewer(casKey, 'stale', 10, 30)).toBe(false);
    await expect(service.getJsonWithVersion(casKey)).resolves.toEqual({
      version: 20,
      payload: 'new',
    });

    const dataKey = `${prefix}:fenced-data`;
    const versionKey = `${prefix}:fenced-version`;
    const initialVersion = await service.getVersion(versionKey);
    expect(initialVersion).toEqual(expect.any(String));
    expect(
      await service.setJsonIfVersionMatches(
        dataKey,
        versionKey,
        initialVersion!,
        { generation: 1 },
        30,
      ),
    ).toBe(true);
    expect(await service.invalidateVersionedKey(dataKey, versionKey)).toBe(
      true,
    );
    expect(
      await service.setJsonIfVersionMatches(
        dataKey,
        versionKey,
        initialVersion!,
        { stale: true },
        30,
      ),
    ).toBe(false);
    expect(await admin.ttl(versionKey)).toBeGreaterThan(86_000);
  });

  it('publishes messages to a real pattern subscriber', async () => {
    const channel = `${prefix}:events:one`;
    const received = new Promise<{ channel: string; message: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('pub/sub message timed out')),
          2_000,
        );
        void service.subscribePattern(`${prefix}:events:*`, (seen, message) => {
          clearTimeout(timer);
          resolve({ channel: seen, message });
        });
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await service.publish(channel, 'hello')).toBe(true);
    await expect(received).resolves.toEqual({ channel, message: 'hello' });
  });

  it('shares rate-limit counts through rate-limit-redis', async () => {
    const first = service.createRateLimitStore(`${prefix}:limiter`)!;
    const second = service.createRateLimitStore(`${prefix}:limiter`)!;
    const options = { windowMs: 60_000 } as Options;
    first.init?.(options);
    second.init?.(options);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const firstResult = await first.increment('same-client');
    const secondResult = await second.increment('same-client');

    expect(firstResult.totalHits).toBe(1);
    expect(secondResult.totalHits).toBe(2);
    await first.shutdown?.();
    await second.shutdown?.();
  });

  it('times out blocked commands and records the bounded failure reason', async () => {
    await admin.call('CLIENT', 'PAUSE', '1500', 'ALL');
    const startedAt = Date.now();

    await expect(service.getJson(`${prefix}:timeout`)).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_400);
    const output = await redisMetrics.registry.metrics();
    expect(output).toMatch(
      /redis_command_failures_total\{operation="get",reason="timeout"\}\s+[1-9]/,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
});
