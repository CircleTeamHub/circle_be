import { RedisService } from './redis.service';
import { FallbackRateLimitStore } from './fallback-rate-limit-store';

const mockGetServerConfig = jest.fn<Record<string, unknown>, []>(() => ({}));

jest.mock('src/config/server.config', () => ({
  getServerConfig: () => mockGetServerConfig(),
}));

describe('RedisService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    mockGetServerConfig.mockReturnValue({});
    process.env = { ...originalEnv };
    delete process.env.REDIS_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('degrades gracefully when REDIS_URL is not configured', async () => {
    const service = new RedisService();

    await expect(service.publish('circle:test', 'payload')).resolves.toBe(
      false,
    );
    await expect(service.subscribePattern('circle:*', jest.fn())).resolves.toBe(
      false,
    );
    await expect(service.getJson('circle:test')).resolves.toBeNull();
    await expect(
      service.setJson('circle:test', { ok: true }, 10),
    ).resolves.toBe(false);
    await expect(service.deleteKey('circle:test')).resolves.toBe(false);
    await expect(
      service.incrementWithTtl('rl:upload-presign:user:user-1', 60),
    ).resolves.toBeNull();
    expect(service.createRateLimitStore('global')).toBeUndefined();
  });

  it('creates distinct rate-limit stores when Redis is configured', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();

    const globalStore = service.createRateLimitStore('global');
    const authStore = service.createRateLimitStore('auth_login');

    expect(globalStore).toBeDefined();
    expect(authStore).toBeDefined();
    expect(globalStore).not.toBe(authStore);
  });

  it('increments a fixed-window counter atomically with Redis TTL', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    const client = {
      eval: jest.fn().mockResolvedValue(2),
    };
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(client);

    await expect(
      service.incrementWithTtl('rl:upload-presign:user:user-1', 60),
    ).resolves.toBe(2);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR'"),
      1,
      'rl:upload-presign:user:user-1',
      '60',
    );
  });

  it('degrades safely on every operation when the command client is unavailable (Redis down)', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(null);

    await expect(service.getJson('k')).resolves.toBeNull();
    await expect(service.setJson('k', { a: 1 }, 10)).resolves.toBe(false);
    await expect(service.deleteKey('k')).resolves.toBe(false);
    await expect(service.incrementWithTtl('k', 10)).resolves.toBeNull();
    await expect(service.setJsonIfNewer('k', { a: 1 }, 5, 10)).resolves.toBe(
      false,
    );
    await expect(service.getJsonWithVersion('k')).resolves.toBeNull();
  });

  it('writes a versioned value only when the CAS script reports success', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    const client = { eval: jest.fn() };
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(client);

    client.eval.mockResolvedValueOnce(1);
    await expect(service.setJsonIfNewer('k', { a: 1 }, 5, 10)).resolves.toBe(
      true,
    );

    client.eval.mockResolvedValueOnce(0);
    await expect(service.setJsonIfNewer('k', { a: 1 }, 5, 10)).resolves.toBe(
      false,
    );

    expect(client.eval).toHaveBeenLastCalledWith(
      expect.stringContaining('cjson.decode'),
      1,
      'k',
      expect.stringContaining('"__ver":5'),
      '5',
      '10',
    );
  });

  it('reads back a versioned value and ignores non-versioned envelopes', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    const client = { get: jest.fn() };
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(client);

    client.get.mockResolvedValueOnce(
      JSON.stringify({ __ver: 7, payload: { vip: 2 } }),
    );
    await expect(service.getJsonWithVersion('k')).resolves.toEqual({
      version: 7,
      payload: { vip: 2 },
    });

    // A legacy / foreign value without a version stamp is treated as a miss.
    client.get.mockResolvedValueOnce(JSON.stringify({ vip: 2 }));
    await expect(service.getJsonWithVersion('k')).resolves.toBeNull();
  });

  it('wraps rate-limit stores so a Redis outage fails over to memory, not open', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();

    const store = service.createRateLimitStore('auth_login');

    expect(store).toBeInstanceOf(FallbackRateLimitStore);
  });
});
