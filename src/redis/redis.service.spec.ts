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
    delete process.env.REDIS_REQUIRED;
    delete process.env.REDIS_ALLOW_INSECURE;
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

  it('applies a hard timeout to every Redis command', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();

    const client = (service as any).createClient();

    expect(client.options.commandTimeout).toBe(1_000);
    client.disconnect();
  });

  it('warns but allows production startup when Redis is not configured by default', async () => {
    process.env.NODE_ENV = 'production';
    const service = new RedisService();
    const warn = jest.spyOn((service as any).logger, 'warn');

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('REDIS_URL is not configured'),
    );
  });

  it('fails production startup without Redis when strict mode is enabled', async () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = 'true';
    const service = new RedisService();

    await expect(service.onModuleInit()).rejects.toThrow(
      'REDIS_URL is required when REDIS_REQUIRED=true',
    );
  });

  it('enforces strict Redis startup in development too', async () => {
    process.env.NODE_ENV = 'development';
    process.env.REDIS_REQUIRED = 'true';
    const service = new RedisService();

    await expect(service.onModuleInit()).rejects.toThrow(
      'REDIS_URL is required when REDIS_REQUIRED=true',
    );
  });

  it('verifies Redis connectivity before accepting production traffic', async () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    const client = { ping: jest.fn().mockResolvedValue('PONG') };
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(client);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it('warns and degrades when configured Redis is unreachable by default', async () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(null);
    const warn = jest.spyOn((service as any).logger, 'warn');

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Redis is unavailable during production startup'),
    );
  });

  it('fails production startup when strict Redis is unreachable', async () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = 'true';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(null);

    await expect(service.onModuleInit()).rejects.toThrow(
      'Redis is unavailable during production startup',
    );
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
      expect.stringContaining("redis.call('INCRBY'"),
      1,
      'rl:upload-presign:user:user-1',
      '60',
      '1',
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
    await expect(service.getVersion('k:version')).resolves.toBeNull();
    await expect(
      service.setJsonIfVersionMatches('k', 'k:version', '', { a: 1 }, 10),
    ).resolves.toBe(false);
    await expect(
      service.invalidateVersionedKey('k', 'k:version'),
    ).resolves.toBe(false);
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

  it('uses a separate version fence for race-safe cache repopulation', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();
    const client = {
      eval: jest
        .fn()
        .mockResolvedValueOnce('token-seeded')
        .mockResolvedValueOnce('token-7')
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1),
    };
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(client);

    await expect(service.getVersion('badge:version')).resolves.toBe(
      'token-seeded',
    );
    await expect(service.getVersion('badge:version')).resolves.toBe('token-7');
    await expect(
      service.setJsonIfVersionMatches(
        'badge:data',
        'badge:version',
        'token-7',
        { unread: 2 },
        10,
      ),
    ).resolves.toBe(true);
    await expect(
      service.invalidateVersionedKey('badge:data', 'badge:version'),
    ).resolves.toBe(true);

    expect(client.eval).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("redis.call('GET', KEYS[2])"),
      2,
      'badge:data',
      'badge:version',
      expect.stringContaining('"unread":2'),
      'token-7',
      '10',
    );
    expect(client.eval).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("redis.call('SET', KEYS[2]"),
      2,
      'badge:data',
      'badge:version',
      expect.any(String),
      '86400',
    );
  });

  it('wraps rate-limit stores so a Redis outage fails over to memory, not open', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new RedisService();

    const store = service.createRateLimitStore('auth_login');

    expect(store).toBeInstanceOf(FallbackRateLimitStore);
  });
});
