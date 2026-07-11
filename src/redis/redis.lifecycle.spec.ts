import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisService } from './redis.service';

describe('RedisService Nest lifecycle', () => {
  const originalEnv = { ...process.env };
  let app: INestApplication | undefined;

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_REQUIRED = 'true';
    process.env.NODE_ENV = 'test';
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    process.env = { ...originalEnv };
  });

  async function createApp(client: unknown): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      providers: [RedisService],
    }).compile();
    const service = moduleRef.get(RedisService);
    jest.spyOn(service as any, 'getCommandClient').mockResolvedValue(client);
    return moduleRef.createNestApplication();
  }

  it('completes app.init when strict Redis answers PONG', async () => {
    const ping = jest.fn().mockResolvedValue('PONG');
    app = await createApp({ ping });

    await expect(app.init()).resolves.toBe(app);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('rejects app.init when strict Redis is unavailable', async () => {
    app = await createApp(null);

    await expect(app.init()).rejects.toThrow(
      'Redis is unavailable during production startup',
    );
  });

  it('rejects app.init when strict Redis returns an invalid PING response', async () => {
    app = await createApp({ ping: jest.fn().mockResolvedValue('LOADING') });

    await expect(app.init()).rejects.toThrow(
      'unexpected PING response: LOADING',
    );
  });

  it('allows app.init in graceful mode when Redis is unavailable', async () => {
    process.env.REDIS_REQUIRED = 'false';
    process.env.NODE_ENV = 'production';
    app = await createApp(null);

    await expect(app.init()).resolves.toBe(app);
  });
});
