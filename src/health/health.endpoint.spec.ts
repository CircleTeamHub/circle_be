import { Logger } from '@nestjs/common';
import {
  createLivenessHandler,
  createReadinessHandler,
  type HealthDatabase,
  type HealthRedis,
} from './health.endpoint';

const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

afterAll(() => errorSpy.mockRestore());

function buildResponse() {
  const res = {
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

function buildDatabase(result: Promise<unknown>): HealthDatabase {
  return { $queryRaw: jest.fn(() => result) } as unknown as HealthDatabase;
}

function buildRedis(enabled: boolean, reachable = true): HealthRedis {
  return {
    isEnabled: jest.fn(() => enabled),
    ping: jest.fn(async () => reachable),
  };
}

describe('createLivenessHandler', () => {
  it('answers 200 without touching any dependency', () => {
    const res = buildResponse();

    createLivenessHandler()({} as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });
});

describe('createReadinessHandler', () => {
  it('answers 200 and verifies the database with a real query', async () => {
    const database = buildDatabase(Promise.resolve([{ '?column?': 1 }]));
    const res = buildResponse();

    await createReadinessHandler({ database, redis: buildRedis(true) })(
      {} as never,
      res as never,
    );

    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      database: 'up',
      redis: 'up',
    });
  });

  it('answers 503 with a JSON body when the database is unreachable', async () => {
    const database = buildDatabase(
      Promise.reject(new Error('ECONNREFUSED 10.0.0.5:5432')),
    );
    const res = buildResponse();

    await createReadinessHandler({ database, redis: buildRedis(true) })(
      {} as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      database: 'down',
      redis: 'up',
    });
    // The probe body stays terse, so the cause has to reach the logs.
    expect(errorSpy).toHaveBeenCalledWith(
      'Readiness probe failed: database is unreachable',
      expect.stringContaining('ECONNREFUSED'),
    );
  });

  it('stays ready when Redis is down — it is optional, the app degrades', async () => {
    const database = buildDatabase(Promise.resolve([]));
    const res = buildResponse();

    await createReadinessHandler({
      database,
      redis: buildRedis(true, false),
    })({} as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      database: 'up',
      redis: 'down',
    });
  });

  it('reports Redis as disabled when it is not configured, without pinging', async () => {
    const database = buildDatabase(Promise.resolve([]));
    const redis = buildRedis(false);
    const res = buildResponse();

    await createReadinessHandler({ database, redis })(
      {} as never,
      res as never,
    );

    expect(redis.ping).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      database: 'up',
      redis: 'disabled',
    });
  });

  it('reports Redis as disabled when the service could not be resolved', async () => {
    const database = buildDatabase(Promise.resolve([]));
    const res = buildResponse();

    await createReadinessHandler({ database, redis: null })(
      {} as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      database: 'up',
      redis: 'disabled',
    });
  });
});
