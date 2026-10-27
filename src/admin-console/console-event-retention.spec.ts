import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { ConsoleInsightsService } from './console-insights.service';

/**
 * ConsoleEvent 保留期清理。原来每天最多删 10 × 1000 行,写入一旦超过每天一万行,
 * 180 天之后表就只增不减。现在要删到干净为止,同时受总时长上限和多实例租约约束。
 */
describe('console event retention', () => {
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-10-25T04:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function setup(lease: string | null | undefined = undefined) {
    const prisma = {
      $executeRaw: jest.fn<Promise<number>, unknown[]>(),
      consoleEvent: { findMany: jest.fn(), deleteMany: jest.fn() },
    };
    const redis = {
      tryAcquireLease: jest.fn().mockResolvedValue(lease),
      renewLease: jest.fn().mockResolvedValue(true),
      releaseLease: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ConsoleInsightsService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
    );
    return { prisma, redis, service };
  }

  const sqlText = (call: unknown[]): string =>
    (call[0] as TemplateStringsArray).join('?');

  it('keeps deleting indexed batches until the backlog is empty', async () => {
    const { prisma, service } = setup();
    prisma.$executeRaw
      .mockResolvedValueOnce(5_000)
      .mockResolvedValueOnce(5_000)
      .mockResolvedValueOnce(1_234);

    await expect(service.cleanEvents()).resolves.toBe(11_234);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    const [call] = prisma.$executeRaw.mock.calls;
    expect(sqlText(call)).toContain('ORDER BY "createdAt"');
    expect(sqlText(call)).toContain('FOR UPDATE SKIP LOCKED');
    expect(call.slice(1)).toEqual([new Date(now - 180 * 86_400_000), 5_000]);
    expect(prisma.consoleEvent.findMany).not.toHaveBeenCalled();
  });

  it('stops at the total time budget even if rows remain', async () => {
    const { prisma, service } = setup();
    // 每批「耗时」一分钟:预算 5 分钟,所以最多 5 批。
    prisma.$executeRaw.mockImplementation(() => {
      now += 60_000;
      return Promise.resolve(5_000);
    });

    await expect(service.cleanEvents()).resolves.toBe(25_000);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(5);
  });

  it('leaves the sweep to the replica that holds the lease', async () => {
    const { prisma, redis, service } = setup(null);

    await expect(service.cleanEvents()).resolves.toBe(0);

    expect(redis.tryAcquireLease).toHaveBeenCalledWith(
      'job-lease:console_event_retention',
      expect.any(Number),
    );
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('stops between batches once the lease is no longer current', async () => {
    const { prisma, redis, service } = setup('owner');
    // 第一批之后时钟越过租约到期时间(续租定时器还没来得及跑)。
    prisma.$executeRaw.mockImplementation(() => {
      now += 10 * 60_000;
      return Promise.resolve(5_000);
    });

    await expect(service.cleanEvents()).resolves.toBe(5_000);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(redis.releaseLease).toHaveBeenCalledWith(
      'job-lease:console_event_retention',
      'owner',
    );
  });
});
