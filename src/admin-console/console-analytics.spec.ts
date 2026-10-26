import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { ConsoleInsightsService } from './console-insights.service';

/**
 * 运营台分析是四条全窗口聚合。原来 Promise.all 一次占 4 个池连接(池默认 10),
 * 三个页签各一个 days 就是 12 条并发,失败也不缓存 —— 窗口一大,看板一刷新就能
 * 把业务请求挤出连接池。这里钉住:一次只跑一条、不同 days 排队、失败短时负缓存。
 */
describe('console analytics load shedding', () => {
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-10-25T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function setup() {
    const tracker = { active: 0, peak: 0 };
    // 每次调用都让出一轮事件循环:并发跑的话 active 会叠起来。
    const track = async <T>(value: T): Promise<T> => {
      tracker.active += 1;
      tracker.peak = Math.max(tracker.peak, tracker.active);
      await new Promise((done) => setImmediate(done));
      tracker.active -= 1;
      return value;
    };
    const prisma = {
      consoleCollectionState: {
        findUniqueOrThrow: jest.fn(() =>
          track({ startedAt: new Date('2026-10-17T00:00:00.000Z') }),
        ),
      },
      $queryRaw: jest.fn<Promise<unknown[]>, unknown[]>(() =>
        track([{ registered: 1, opened: 1, joined: 0, messaged: 0 }]),
      ),
    };
    const service = new ConsoleInsightsService(
      prisma as unknown as PrismaService,
      {} as RedisService,
    );
    return { prisma, service, tracker };
  }

  it('runs the four aggregates one at a time on a single connection', async () => {
    const { prisma, service, tracker } = setup();
    const result = await service.analytics(30);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(tracker.peak).toBe(1);
    expect(result.funnel).toEqual({
      registered: 1,
      opened: 1,
      joined: 0,
      messaged: 0,
    });
  });

  it('queues different windows behind each other instead of computing them in parallel', async () => {
    const { prisma, service, tracker } = setup();
    const results = await Promise.all([
      service.analytics(7),
      service.analytics(30),
      service.analytics(90),
    ]);
    expect(results.map((result) => result.days)).toEqual([7, 30, 90]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(12);
    expect(tracker.peak).toBe(1);
  });

  it('shares one computation between concurrent reads of the same window and caches it', async () => {
    const { prisma, service } = setup();
    const [first, second] = await Promise.all([
      service.analytics(7),
      service.analytics(7),
    ]);
    expect(second).toBe(first);
    now += 44_000;
    await expect(service.analytics(7)).resolves.toBe(first);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('rethrows a recent failure without recomputing, then recomputes after the window', async () => {
    const { prisma, service } = setup();
    const failure = new Error('canceling statement due to statement timeout');
    prisma.$queryRaw.mockRejectedValueOnce(failure);

    await expect(service.analytics(30)).rejects.toBe(failure);
    // 串行之后第一条失败就不会再发后面三条。
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

    now += 29_000;
    await expect(service.analytics(30)).rejects.toBe(failure);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

    now += 2_000;
    await expect(service.analytics(30)).resolves.toMatchObject({ days: 30 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
  });

  it('does not let a failed window block the windows queued behind it', async () => {
    const { prisma, service } = setup();
    const failure = new Error('connection reset');
    prisma.$queryRaw.mockRejectedValueOnce(failure);

    const [failed, succeeded] = await Promise.allSettled([
      service.analytics(7),
      service.analytics(30),
    ]);
    expect(failed).toEqual({ status: 'rejected', reason: failure });
    expect(succeeded).toMatchObject({
      status: 'fulfilled',
      value: { days: 30 },
    });
  });

  it('documents the per-user 5-minute event merge next to the other definitions', async () => {
    const { service } = setup();
    const { definitions } = await service.analytics(30);
    expect(Object.values(definitions).join('\n')).toMatch(
      /每人每 5 分钟.*新登录/,
    );
  });
});
