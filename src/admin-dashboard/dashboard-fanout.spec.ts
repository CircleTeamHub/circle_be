import { DashboardRange } from './dashboard.dto';
import { DashboardService } from './dashboard.service';
import {
  DashboardCommerceMetrics,
  DashboardCommunityMetrics,
  DashboardModerationMetrics,
  DashboardSystemMetrics,
  DashboardUserMetrics,
} from './dashboard-metrics.service';
import { ADMIN_FANOUT_MAX_CONCURRENT_QUERIES } from 'src/utils/concurrency-limit';

/**
 * 看板一次刷新约 20 条查询。以前五个分区 × 各自的 Promise.all 同时打出去,10 个连接
 * 的池被一个管理员请求占满;现在整次刷新共用一个并发上限。
 */
describe('dashboard query fan-out', () => {
  function fakePrisma() {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const query = <T>(value: T) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      return new Promise<T>((resolve) =>
        setImmediate(() => {
          active--;
          resolve(value);
        }),
      );
    };
    const delegate = {
      count: () => query(1),
      aggregate: () =>
        query({
          _count: { _all: 2 },
          _sum: { totalPrice: 30, price: 40, amount: -5 },
        }),
    };
    const prisma = new Proxy(
      { $queryRaw: () => query([]) } as Record<string, unknown>,
      { get: (target, key) => target[key as string] ?? delegate },
    );
    return {
      prisma,
      peak: () => peak,
      calls: () => calls,
      active: () => active,
    };
  }

  function setup() {
    const db = fakePrisma();
    const redis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(true),
    };
    const prisma = db.prisma as never;
    const service = new DashboardService(
      new DashboardUserMetrics(prisma),
      new DashboardCommunityMetrics(prisma),
      new DashboardCommerceMetrics(prisma),
      new DashboardModerationMetrics(prisma),
      new DashboardSystemMetrics(prisma, redis as never),
      redis as never,
    );
    return { db, service };
  }

  it('keeps at most three dashboard queries in flight and still returns every section', async () => {
    const { db, service } = setup();

    const result = await service.getDashboard(DashboardRange.Today);

    expect(db.calls()).toBe(20);
    expect(db.peak()).toBeLessThanOrEqual(ADMIN_FANOUT_MAX_CONCURRENT_QUERIES);
    expect(db.active()).toBe(0);
    expect(Object.values(result.sections).map((s) => s.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(result.sections.commerce.data).toMatchObject({
      activeMembers: 1,
      fancyNumberOrders: 2,
      fancyNumberSpend: 30,
      expansionSpend: 40,
      pointSpend: 5,
    });
    expect(result.sections.moderation.data).toMatchObject({ pendingTotal: 3 });
  });

  it('shares the cap across concurrent refreshes of different ranges', async () => {
    const { db, service } = setup();

    await Promise.all([
      service.getDashboard(DashboardRange.Today),
      service.getDashboard(DashboardRange.SevenDays),
    ]);

    expect(db.calls()).toBe(40);
    expect(db.peak()).toBeLessThanOrEqual(ADMIN_FANOUT_MAX_CONCURRENT_QUERIES);
  });
});
