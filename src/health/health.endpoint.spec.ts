import { Logger } from '@nestjs/common';
import {
  createLivenessHandler,
  createReadinessHandler,
  type HealthDatabase,
  type HealthObjectStore,
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

function buildObjectStore(
  status: 'ok' | 'policy-unconfirmed' | 'disabled',
): HealthObjectStore {
  return { objectStoreStatus: jest.fn(() => status) };
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
      objectStore: 'disabled',
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
      objectStore: 'disabled',
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
      objectStore: 'disabled',
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
      objectStore: 'disabled',
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
      objectStore: 'disabled',
    });
  });
});

describe('createReadinessHandler object store reporting', () => {
  // 对象存储的桶策略是**白名单**：notes/ 已从中移除，所以「应用策略」正是让笔记
  // 媒体变私有的动作。它在启动时是 best-effort —— 失败只打日志就继续，旧策略
  // （含 notes/）继续生效，桶仍然匿名可读，而应用照常发预签名 URL、看起来一切
  // 正常。这个「以为修好了其实没修」的状态必须能从探针看出来。
  it('reports the object store policy state', async () => {
    const res = buildResponse();

    await createReadinessHandler({
      database: buildDatabase(Promise.resolve([])),
      redis: buildRedis(false),
      objectStore: buildObjectStore('policy-unconfirmed'),
    })({} as never, res as never);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ objectStore: 'policy-unconfirmed' }),
    );
  });

  it('does not gate readiness on the object store policy', async () => {
    // 若因策略未确认就判 not-ready，所有实例会同时被摘出轮转 —— 把一个可观测的
    // 安全降级放大成全站宕机。与 redis 的处理一致：报告，不阻断。
    const res = buildResponse();

    await createReadinessHandler({
      database: buildDatabase(Promise.resolve([])),
      redis: buildRedis(false),
      objectStore: buildObjectStore('policy-unconfirmed'),
    })({} as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('reports disabled when no object store is wired', async () => {
    const res = buildResponse();

    await createReadinessHandler({
      database: buildDatabase(Promise.resolve([])),
      redis: buildRedis(false),
    })({} as never, res as never);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ objectStore: 'disabled' }),
    );
  });
});
