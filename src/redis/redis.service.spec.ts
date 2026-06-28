import { RedisService } from './redis.service';

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
});
