import { Injectable } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { OutboxService } from 'src/outbox/outbox.service';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { buildDailySeries, type DashboardPeriod } from './dashboard-period';

@Injectable()
export class DashboardUserMetrics {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(period: DashboardPeriod) {
    const [totalUsers, newUsers, activeUsers, bannedUsers, signupRows] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.user.count({
          where: { createdAt: { gte: period.startAt, lte: period.endAt } },
        }),
        this.prisma.user.count({
          where: { lastOnline: { gte: period.startAt, lte: period.endAt } },
        }),
        this.prisma.user.count({ where: { status: 'BANNED' } }),
        this.prisma.$queryRaw<
          Array<{ date: string; count: bigint }>
        >(Prisma.sql`
          SELECT
            to_char("createdAt" AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS "date",
            COUNT(*)::bigint AS "count"
          FROM "User"
          WHERE "createdAt" >= ${period.startAt}
            AND "createdAt" <= ${period.endAt}
          GROUP BY 1
          ORDER BY 1
        `),
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

  async getMetrics(period: DashboardPeriod) {
    const [totalCircles, newCircles, newPosts, newMembers] = await Promise.all([
      this.prisma.circle.count({ where: { deleted: false } }),
      this.prisma.circle.count({
        where: {
          deleted: false,
          createdAt: { gte: period.startAt, lte: period.endAt },
        },
      }),
      this.prisma.circlePost.count({
        where: { createdAt: { gte: period.startAt, lte: period.endAt } },
      }),
      this.prisma.circleMember.count({
        where: {
          status: 'ACTIVE',
          createdAt: { gte: period.startAt, lte: period.endAt },
        },
      }),
    ]);
    return { totalCircles, newCircles, newPosts, newMembers };
  }
}

@Injectable()
export class DashboardCommerceMetrics {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(period: DashboardPeriod) {
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
      this.prisma.user.count({
        where: {
          vipLevel: { gt: 0 },
          OR: [{ vipExpiresAt: null }, { vipExpiresAt: { gt: period.endAt } }],
        },
      }),
      this.prisma.membershipGrant.count({ where: { createdAt: range } }),
      this.prisma.fancyNumberLease.count({ where: { endedAt: null } }),
      this.prisma.fancyNumberOrder.aggregate({
        where: { createdAt: range },
        _count: { _all: true },
        _sum: { totalPrice: true },
      }),
      this.prisma.groupExpansionOrder.aggregate({
        where: { createdAt: range },
        _count: { _all: true },
        _sum: { price: true },
      }),
      this.prisma.coinTransaction.aggregate({
        where: { type: 'PURCHASE', amount: { lt: 0 }, createdAt: range },
        _sum: { amount: true },
      }),
      this.prisma.coinTransaction.aggregate({
        where: { type: 'RECHARGE', amount: { gt: 0 }, createdAt: range },
        _sum: { amount: true },
      }),
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

  async getMetrics(_period: DashboardPeriod) {
    const [pendingFriendReports, pendingGroupReports, pendingPostReports] =
      await Promise.all([
        this.prisma.friendReport.count({ where: { status: 'PENDING' } }),
        this.prisma.groupReport.count({ where: { status: 'PENDING' } }),
        this.prisma.circlePostReport.count({ where: { status: 'PENDING' } }),
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
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly openim: OpenimService,
  ) {}

  async getMetrics() {
    const [outboxResult, databaseResult, redisResult, openimResult] =
      await Promise.allSettled([
        this.outbox.getHealth(),
        this.prisma.$queryRaw(Prisma.sql`SELECT 1 AS "ok"`),
        this.redis.ping(),
        this.openim.listGroups({ page: 1, limit: 1 }),
      ]);
    const health =
      outboxResult.status === 'fulfilled' ? outboxResult.value : null;
    return {
      pending: health ? health.friend.pending + health.group.pending : 0,
      processing: health
        ? health.friend.processing + health.group.processing
        : 0,
      failed: health ? health.friend.failed + health.group.failed : 0,
      oldestPendingAt: oldestIso(
        health?.friend.oldestPendingAt ?? null,
        health?.group.oldestPendingAt ?? null,
      ),
      oldestFailedAt: oldestIso(
        health?.friend.oldestFailedAt ?? null,
        health?.group.oldestFailedAt ?? null,
      ),
      friend: health?.friend ?? null,
      group: health?.group ?? null,
      services: {
        api: 'healthy',
        database: databaseResult.status === 'fulfilled' ? 'healthy' : 'down',
        redis:
          redisResult.status === 'fulfilled' && redisResult.value
            ? 'healthy'
            : 'down',
        openim: openimResult.status === 'fulfilled' ? 'healthy' : 'down',
      },
    };
  }
}

function oldestIso(...values: Array<Date | null>): string | null {
  const timestamps = values
    .filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime());
  return timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : null;
}
