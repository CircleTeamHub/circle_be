const connectMock = jest.fn();
const disconnectMock = jest.fn();
const prismaPgMock = jest.fn();
const getServerConfigMock = jest.fn();
const poolConstructorMock = jest.fn();
const poolEndMock = jest.fn();

/** 每个 new Pool() 的替身,带 pg.Pool 那几个实时计数器。 */
class MockPool {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  end = poolEndMock;

  constructor(config: unknown) {
    poolConstructorMock(config);
  }
}

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((config: unknown) => new MockPool(config)),
}));

jest.mock('src/generated/prisma', () => ({
  PrismaClient: class MockPrismaClient {
    public readonly options?: unknown;

    constructor(options?: unknown) {
      this.options = options;
    }

    $connect = connectMock;
    $disconnect = disconnectMock;
  },
}));

jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation((poolOrConfig: unknown) => {
    prismaPgMock(poolOrConfig);
    return { poolOrConfig };
  }),
}));

jest.mock('src/config/server.config', () => ({
  getServerConfig: (...args: unknown[]) => getServerConfigMock(...args),
}));

import { Logger } from '@nestjs/common';
import { PrismaService, resolveDatabasePoolConfig } from './prisma.service';

describe('resolveDatabasePoolConfig', () => {
  it('defaults to pg’s pool size, but bounds the acquire wait', () => {
    // pg's own default for connectionTimeoutMillis is 0 = wait forever, which
    // turns a saturated pool into hung requests instead of a visible error.
    expect(resolveDatabasePoolConfig({})).toEqual({
      max: 10,
      connectionTimeoutMillis: 10_000,
      // Postgres 默认 statement_timeout 是 0 = 不限：一条失控的查询能占着池里的
      // 一个连接直到跑完，几条就能让整个实例的其它请求全部卡在取连接超时上。
      statement_timeout: 15_000,
    });
  });

  it('reads every knob from the environment', () => {
    expect(
      resolveDatabasePoolConfig({
        DATABASE_POOL_MAX: '25',
        DATABASE_POOL_ACQUIRE_TIMEOUT_MS: '3000',
        DATABASE_STATEMENT_TIMEOUT_MS: '5000',
      }),
    ).toEqual({
      max: 25,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
  });

  it('falls back to defaults for unusable values rather than failing boot', () => {
    expect(
      resolveDatabasePoolConfig({
        DATABASE_POOL_MAX: 'ten',
        DATABASE_POOL_ACQUIRE_TIMEOUT_MS: '0',
      }),
    ).toEqual({
      max: 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
    expect(resolveDatabasePoolConfig({ DATABASE_POOL_MAX: '-5' })).toEqual({
      max: 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
  });
});

describe('PrismaService', () => {
  const originalEnv = process.env;
  const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.ALLOW_START_WITHOUT_DB;
    delete process.env.PRISMA_SKIP_CONNECT_ON_BOOT;
    delete process.env.NODE_ENV;
    delete process.env.JEST_WORKER_ID;
    getServerConfigMock.mockReturnValue({});
  });

  afterAll(() => {
    process.env = originalEnv;
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('throws when DATABASE_URL is missing and degraded startup is disabled', () => {
    expect(() => new PrismaService()).toThrow(
      'DATABASE_URL is not configured. Set it in your environment or .env file.',
    );
  });

  it('allows construction without DATABASE_URL when degraded startup is enabled', () => {
    process.env.ALLOW_START_WITHOUT_DB = 'true';

    expect(() => new PrismaService()).not.toThrow();
    expect(prismaPgMock).not.toHaveBeenCalled();
    expect(poolConstructorMock).not.toHaveBeenCalled();
  });

  it('passes the pool size and acquire timeout to the pg adapter', () => {
    process.env.DATABASE_URL = 'postgresql://example';

    expect(() => new PrismaService()).not.toThrow();

    // 池现在由 PrismaService 自己建并持有(为了读 waitingCount),配置因此落在
    // Pool 构造函数上而不是适配器上。
    expect(poolConstructorMock).toHaveBeenCalledWith({
      connectionString: 'postgresql://example',
      max: 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
    });
    // 适配器拿到的必须是同一个池实例,不是另一份配置 —— 否则会凭空多出
    // 第二个连接池,而指标读的是没人用的那个。
    expect(prismaPgMock).toHaveBeenCalledWith(expect.any(MockPool));
  });

  it('lets the environment override pool settings from the .env file', () => {
    getServerConfigMock.mockReturnValue({
      DATABASE_URL: 'postgresql://from-file',
      DATABASE_POOL_MAX: '5',
    });
    process.env.DATABASE_POOL_MAX = '30';

    expect(() => new PrismaService()).not.toThrow();

    expect(poolConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://from-file',
        max: 30,
      }),
    );
  });

  it('skips boot-time connection when PRISMA_SKIP_CONNECT_ON_BOOT is enabled', async () => {
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.PRISMA_SKIP_CONNECT_ON_BOOT = 'true';
    const service = new PrismaService();

    await service.onModuleInit();

    expect(connectMock).not.toHaveBeenCalled();
    expect(service.isDatabaseConnected()).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns false from connectIfNeeded when degraded startup is enabled without a database URL', async () => {
    process.env.ALLOW_START_WITHOUT_DB = 'true';
    const service = new PrismaService();

    await expect(service.connectIfNeeded()).resolves.toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('marks the service connected after a successful boot-time connection', async () => {
    process.env.DATABASE_URL = 'postgresql://example';
    connectMock.mockResolvedValueOnce(undefined);
    const service = new PrismaService();

    await service.onModuleInit();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(service.isDatabaseConnected()).toBe(true);
    expect(logSpy).toHaveBeenCalled();
  });

  it('exposes the live pool counters for /metrics', () => {
    process.env.DATABASE_URL = 'postgresql://example';
    const service = new PrismaService();

    const pool = service.getPoolForTest() as unknown as MockPool;
    pool.totalCount = 9;
    pool.idleCount = 1;
    pool.waitingCount = 4;

    expect(service.getPoolStats()).toEqual({
      max: 10,
      total: 9,
      idle: 1,
      waiting: 4,
    });
  });

  it('reports no pool stats when running without a database', () => {
    process.env.ALLOW_START_WITHOUT_DB = 'true';
    const service = new PrismaService();

    expect(service.getPoolStats()).toBeNull();
  });

  it('closes the pool it owns on shutdown', async () => {
    // @prisma/adapter-pg 只在**自己**创建池时负责销毁它。既然改成由
    // PrismaService 建池(为了读 waitingCount),关闭责任就一并转移过来 ——
    // 漏掉这一步,每次优雅重启都会留下一把不归还的 Postgres 连接。
    process.env.DATABASE_URL = 'postgresql://example';
    const service = new PrismaService();

    await service.onModuleDestroy();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(poolEndMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail shutdown when the pool is already closed', async () => {
    process.env.DATABASE_URL = 'postgresql://example';
    const service = new PrismaService();
    poolEndMock.mockRejectedValueOnce(
      new Error('Called end on pool more than once'),
    );

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
