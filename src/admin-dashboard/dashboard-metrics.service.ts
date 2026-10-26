import { Injectable } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import {
  type ConcurrencyLimiter,
  runUnlimited,
} from 'src/utils/concurrency-limit';
import { buildDailySeries, type DashboardPeriod } from './dashboard-period';

// 每条查询都包成 thunk 交给 limit:看板一次刷新约 20 条,由 DashboardService 传入
// 共享的并发上限,不再让各分区的 Promise.all 同时占满连接池。

@Injectable()
export class DashboardUserMetrics {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(
    period: DashboardPeriod,
    limit: ConcurrencyLimiter = runUnlimited,
  ) {
    const [totalUsers, newUsers, activeUsers, bannedUsers, signupRows] =
      await Promise.all([
        limit(() => this.prisma.user.count()),
        limit(() =>
          this.prisma.user.count({
            where: { createdAt: { gte: period.startAt, lte: period.endAt } },
          }),
        ),
        limit(() =>
          this.prisma.user.count({
            where: { lastOnline: { gte: period.startAt, lte: period.endAt } },
          }),
        ),
        limit(() => this.prisma.user.count({ where: { status: 'BANNED' } })),
        limit(() =>
          this.prisma.$queryRaw<Array<{ date: string; count: bigint }>>(
            Prisma.sql`
          SELECT
            to_char("createdAt" AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS "date",
            COUNT(*)::bigint AS "count"
          FROM "User"
          WHERE "createdAt" >= ${period.startAt}
            AND "createdAt" <= ${period.endAt}
          GROUP BY 1
          ORDER BY 1
        `,
          ),
        ),
      ]);
    return {
      totalUsers,
      newUsers,
      activeUsers,
      bannedUsers,
      signupTrend: buildDailySeries(period, signupRows),
    };
  }
}

@Injectable()
export class DashboardCommunityMetrics {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(
    period: DashboardPeriod,
    limit: ConcurrencyLimiter = runUnlimited,
  ) {
    const [totalCircles, newCircles, newPosts, newMembers] = await Promise.all([
      limit(() => this.prisma.circle.count({ where: { deleted: false } })),
      limit(() =>
        this.prisma.circle.count({
          where: {
            deleted: false,
            createdAt: { gte: period.startAt, lte: period.endAt },
          },
        }),
      ),
      limit(() =>
        this.prisma.circlePost.count({
          where: { createdAt: { gte: period.startAt, lte: period.endAt } },
        }),
      ),
      limit(() =>
        this.prisma.circleMember.count({
          where: {
            status: 'ACTIVE',
            createdAt: { gte: period.startAt, lte: period.endAt },
          },
        }),
      ),
    ]);
    return { totalCircles, newCircles, newPosts, newMembers };
  }
}

@Injectable()
export class DashboardCommerceMetrics {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(
    period: DashboardPeriod,
    limit: ConcurrencyLimiter = runUnlimited,
  ) {
    const range = { gte: period.startAt, lte: period.endAt };
    const [
      activeMembers,
      newMemberships,
      activeFancyNumbers,
      fancyOrders,
      expansionOrders,
      pointSpend,
      pointRecharge,
    ] = await Promise.all([
      limit(() =>
        this.prisma.user.count({
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
        }),
      ),
      limit(() =>
        this.prisma.membershipGrant.count({ where: { createdAt: range } }),
      ),
      limit(() =>
        this.prisma.fancyNumberLease.count({
          where: {
            endedAt: null,
            OR: [
              { permanentAt: { not: null } },
              { expiresAt: { gt: period.endAt } },
            ],
          },
        }),
      ),
      limit(() =>
        this.prisma.fancyNumberOrder.aggregate({
          where: { createdAt: range },
          _count: { _all: true },
          _sum: { totalPrice: true },
        }),
      ),
      limit(() =>
        this.prisma.groupExpansionOrder.aggregate({
          where: { createdAt: range },
          _count: { _all: true },
          _sum: { price: true },
        }),
      ),
      limit(() =>
        this.prisma.coinTransaction.aggregate({
          where: { type: 'PURCHASE', amount: { lt: 0 }, createdAt: range },
          _sum: { amount: true },
        }),
      ),
      limit(() =>
        this.prisma.coinTransaction.aggregate({
          where: { type: 'RECHARGE', amount: { gt: 0 }, createdAt: range },
          _sum: { amount: true },
        }),
      ),
    ]);
    return {
      activeMembers,
      newMemberships,
      activeFancyNumbers,
      fancyNumberOrders: fancyOrders._count._all,
      fancyNumberSpend: fancyOrders._sum.totalPrice ?? 0,
      expansionOrders: expansionOrders._count._all,
      expansionSpend: expansionOrders._sum.price ?? 0,
      pointSpend: Math.abs(pointSpend._sum.amount ?? 0),
      pointRecharge: pointRecharge._sum.amount ?? 0,
    };
  }
}

@Injectable()
export class DashboardModerationMetrics {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(
    _period: DashboardPeriod,
    limit: ConcurrencyLimiter = runUnlimited,
  ) {
    const [pendingFriendReports, pendingGroupReports, pendingPostReports] =
      await Promise.all([
        limit(() =>
          this.prisma.friendReport.count({ where: { status: 'PENDING' } }),
        ),
        limit(() =>
          this.prisma.groupReport.count({ where: { status: 'PENDING' } }),
        ),
        limit(() =>
          this.prisma.circlePostReport.count({ where: { status: 'PENDING' } }),
        ),
      ]);
    return {
      pendingFriendReports,
      pendingGroupReports,
      pendingPostReports,
      pendingTotal:
        pendingFriendReports + pendingGroupReports + pendingPostReports,
    };
  }
}

@Injectable()
export class DashboardSystemMetrics {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getMetrics(limit: ConcurrencyLimiter = runUnlimited) {
    const [databaseResult, redisResult] = await Promise.allSettled([
      limit(() => this.prisma.$queryRaw(Prisma.sql`SELECT 1 AS "ok"`)),
      this.redis.ping(),
    ]);
    // 只回真实探针。OpenIM 同步 outbox 早已拆除,此前保形置零的 pending/processing/
    // failed/oldest*/friend/group 只会在面板上显示一排永远为 0 的假队列。
    return {
      services: {
        api: 'healthy',
        database: databaseResult.status === 'fulfilled' ? 'healthy' : 'down',
        redis:
          redisResult.status === 'fulfilled' && redisResult.value
            ? 'healthy'
            : 'down',
      },
    };
  }
}
