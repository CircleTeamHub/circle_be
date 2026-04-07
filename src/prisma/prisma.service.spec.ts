const connectMock = jest.fn();
const disconnectMock = jest.fn();
const prismaPgMock = jest.fn();
const getServerConfigMock = jest.fn();

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
  PrismaPg: jest.fn().mockImplementation((options: unknown) => {
    prismaPgMock(options);
    return { options };
  }),
}));

jest.mock('src/config/server.config', () => ({
  getServerConfig: (...args: unknown[]) => getServerConfigMock(...args),
}));

import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

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
});
