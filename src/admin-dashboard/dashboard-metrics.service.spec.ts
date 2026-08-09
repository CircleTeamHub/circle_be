import {
  DashboardCommerceMetrics,
  DashboardCommunityMetrics,
  DashboardModerationMetrics,
  DashboardSystemMetrics,
  DashboardUserMetrics,
} from './dashboard-metrics.service';

describe('dashboard metric providers', () => {
  const period = {
    startAt: new Date('2026-07-23T00:00:00.000Z'),
    endAt: new Date('2026-07-29T12:00:00.000Z'),
    dayCount: 7,
  };

  it('builds user totals and a normalized daily signup trend', async () => {
    const prisma = {
      user: {
        count: jest
          .fn()
          .mockResolvedValueOnce(100)
          .mockResolvedValueOnce(8)
          .mockResolvedValueOnce(40)
          .mockResolvedValueOnce(3),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { day: new Date('2026-07-23T00:00:00.000Z'), count: BigInt(2) },
        { day: new Date('2026-07-29T00:00:00.000Z'), count: BigInt(6) },
      ]),
    };

    const result = await new DashboardUserMetrics(prisma as never).getMetrics(
      period,
    );

    expect(result).toMatchObject({
      totalUsers: 100,
      newUsers: 8,
      activeUsers: 40,
      bannedUsers: 3,
    });
    expect(result.signupTrend).toHaveLength(7);
    expect(result.signupTrend[0]).toEqual({
      date: '2026-07-23',
      value: 2,
    });
    expect(result.signupTrend[6]).toEqual({
      date: '2026-07-29',
      value: 6,
    });
  });

  it('builds community metrics', async () => {
    const prisma = {
      circle: {
        count: jest.fn().mockResolvedValueOnce(20).mockResolvedValueOnce(4),
      },
      circlePost: { count: jest.fn().mockResolvedValue(30) },
      circleMember: { count: jest.fn().mockResolvedValue(15) },
    };

    await expect(
      new DashboardCommunityMetrics(prisma as never).getMetrics(period),
    ).resolves.toEqual({
      totalCircles: 20,
      newCircles: 4,
      newPosts: 30,
      newMembers: 15,
    });
  });

  it('builds commerce counts and point totals', async () => {
    const prisma = {
      user: { count: jest.fn().mockResolvedValue(12) },
      membershipGrant: { count: jest.fn().mockResolvedValue(3) },
      fancyNumberLease: { count: jest.fn().mockResolvedValue(5) },
      fancyNumberOrder: {
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 7 },
          _sum: { totalPrice: 700 },
        }),
      },
      groupExpansionOrder: {
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 2 },
          _sum: { price: 400 },
        }),
      },
      coinTransaction: {
        aggregate: jest
          .fn()
          .mockResolvedValueOnce({ _sum: { amount: -1100 } })
          .mockResolvedValueOnce({ _sum: { amount: 1500 } }),
      },
    };

    await expect(
      new DashboardCommerceMetrics(prisma as never).getMetrics(period),
    ).resolves.toEqual({
      activeMembers: 12,
      newMemberships: 3,
      activeFancyNumbers: 5,
      fancyNumberOrders: 7,
      fancyNumberSpend: 700,
      expansionOrders: 2,
      expansionSpend: 400,
      pointSpend: 1100,
      pointRecharge: 1500,
    });
    expect(prisma.fancyNumberLease.count).toHaveBeenCalledWith({
      where: {
        endedAt: null,
        OR: [
          { permanentAt: { not: null } },
          { expiresAt: { gt: period.endAt } },
        ],
      },
    });
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { vipLevel: { gte: 4 } },
          {
            vipLevel: { gt: 0, lt: 4 },
            OR: [
              { vipExpiresAt: null },
              { vipExpiresAt: { gt: period.endAt } },
            ],
          },
        ],
      },
    });
  });

  it('combines all pending moderation queues', async () => {
    const prisma = {
      friendReport: { count: jest.fn().mockResolvedValue(2) },
      groupReport: { count: jest.fn().mockResolvedValue(3) },
      circlePostReport: { count: jest.fn().mockResolvedValue(4) },
    };

    await expect(
      new DashboardModerationMetrics(prisma as never).getMetrics(period),
    ).resolves.toEqual({
      pendingFriendReports: 2,
      pendingGroupReports: 3,
      pendingPostReports: 4,
      pendingTotal: 9,
    });
  });

  it('reports service health with zeroed legacy outbox fields', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue(true) };

    await expect(
      new DashboardSystemMetrics(prisma as never, redis as never).getMetrics(),
    ).resolves.toMatchObject({
      // OpenIM 同步 outbox 已拆除:字段保形置零,admin_web 面板无需同步升级。
      pending: 0,
      processing: 0,
      failed: 0,
      oldestPendingAt: null,
      oldestFailedAt: null,
      friend: null,
      group: null,
      services: {
        api: 'healthy',
        database: 'healthy',
        redis: 'healthy',
      },
    });
  });

  it('reports database down when the probe rejects', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const redis = { ping: jest.fn().mockResolvedValue(true) };

    await expect(
      new DashboardSystemMetrics(prisma as never, redis as never).getMetrics(),
    ).resolves.toMatchObject({
      services: { api: 'healthy', database: 'down', redis: 'healthy' },
    });
  });
});
