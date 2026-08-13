import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { CoinService } from 'src/coin/coin.service';
import { Prisma, ReferralStatus } from 'src/generated/prisma';
import { TrackedCron } from 'src/metrics/tracked-cron.decorator';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import { MyReferralsDto, ReferralListQueryDto } from './dto/referral.dto';
import { REFERRAL_BATCH_SIZE, REFERRAL_RECHECK_MS } from './referral.constants';
import { readReferralRules, type ReferralRules } from './referral.rules';

type RewardedSettlement = {
  kind: 'rewarded';
  inviterId: string;
  inviteeId: string;
  inviterReward: number;
  inviteeReward: number;
};

type Settlement =
  | RewardedSettlement
  | { kind: 'pending' | 'capped' | 'rejected' | 'expired' | 'noop' };

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);
  private readonly rules: ReferralRules;
  private sweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly coins: CoinService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeService,
    config: ConfigService,
  ) {
    this.rules = readReferralRules(config);
  }

  async getMine(
    userId: string,
    query: ReferralListQueryDto,
  ): Promise<MyReferralsDto> {
    const limit = query.limit;
    const [user, grouped, earned, rows] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { inviteCode: true },
      }),
      this.prisma.referral.groupBy({
        by: ['status'],
        where: { inviterID: userId },
        _count: { _all: true },
      }),
      this.prisma.referral.aggregate({
        where: { inviterID: userId, status: 'REWARDED' },
        _sum: { inviterReward: true },
      }),
      this.prisma.referral.findMany({
        where: { inviterID: userId },
        select: {
          id: true,
          status: true,
          inviterReward: true,
          inviteeReward: true,
          eligibleAt: true,
          expiresAt: true,
          qualifiedAt: true,
          rewardedAt: true,
          failureReason: true,
          createdAt: true,
          invitee: { select: { id: true, nickname: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    ]);

    const counts: Record<ReferralStatus, number> = {
      PENDING: 0,
      REWARDED: 0,
      CAPPED: 0,
      REJECTED: 0,
      EXPIRED: 0,
    };
    for (const row of grouped) counts[row.status] = row._count._all;

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      inviteCode: user.inviteCode,
      rules: { ...this.rules },
      summary: {
        total: Object.values(counts).reduce((sum, value) => sum + value, 0),
        pending: counts.PENDING,
        rewarded: counts.REWARDED,
        capped: counts.CAPPED,
        rejected: counts.REJECTED,
        expired: counts.EXPIRED,
        pointsEarned: earned._sum.inviterReward ?? 0,
      },
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  @TrackedCron(CronExpression.EVERY_HOUR, 'referral_reward_sweep')
  async processDue(now: Date = new Date()): Promise<{
    rewarded: number;
    capped: number;
    rejected: number;
    expired: number;
  }> {
    const totals = { rewarded: 0, capped: 0, rejected: 0, expired: 0 };
    if (!this.rules.enabled || this.sweepInFlight) return totals;

    this.sweepInFlight = true;
    let firstError: unknown = null;
    try {
      const due = await this.prisma.referral.findMany({
        where: { status: 'PENDING', nextCheckAt: { lte: now } },
        select: { id: true },
        orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
        take: REFERRAL_BATCH_SIZE,
      });

      for (const { id } of due) {
        try {
          const settlement = await this.settleOne(id, now);
          if (settlement.kind in totals) {
            totals[settlement.kind as keyof typeof totals] += 1;
          }
          if (settlement.kind === 'rewarded') {
            await this.notifyReward(settlement);
          }
        } catch (error) {
          firstError ??= error;
          this.logger.error(
            `Referral settlement failed for ${id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
      if (firstError) throw firstError;
      if (due.length > 0) {
        this.logger.log(
          `Referral sweep processed ${due.length}: ${JSON.stringify(totals)}`,
        );
      }
      return totals;
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async settleOne(referralId: string, now: Date): Promise<Settlement> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Referral" WHERE "id" = ${referralId} FOR UPDATE
      `;
      const referral = await tx.referral.findUnique({
        where: { id: referralId },
        include: {
          inviter: { select: { id: true, status: true } },
          invitee: {
            select: { id: true, status: true, avatarUrl: true },
          },
        },
      });
      if (!referral || referral.status !== 'PENDING') return { kind: 'noop' };

      if (now >= referral.expiresAt) {
        await tx.referral.update({
          where: { id: referral.id },
          data: {
            status: 'EXPIRED',
            failureReason: 'QUALIFICATION_WINDOW_EXPIRED',
          },
        });
        return { kind: 'expired' };
      }
      // nextCheckAt is an optimization, not the source of truth. Keep the
      // qualification delay enforced even if a row is manually repaired or a
      // future scheduler change selects it early.
      if (now < referral.eligibleAt) {
        await tx.referral.update({
          where: { id: referral.id },
          data: { nextCheckAt: referral.eligibleAt },
        });
        return { kind: 'pending' };
      }
      if (
        referral.inviter.status !== 'ACTIVE' ||
        referral.invitee.status !== 'ACTIVE'
      ) {
        await tx.referral.update({
          where: { id: referral.id },
          data: { status: 'REJECTED', failureReason: 'ACCOUNT_INACTIVE' },
        });
        return { kind: 'rejected' };
      }
      if (!referral.invitee.avatarUrl) {
        await this.deferPending(tx, referral.id, referral.expiresAt, now);
        return { kind: 'pending' };
      }

      const acceptedFriend = await tx.friend.findFirst({
        where: {
          state: 'ACCEPTED',
          OR: [
            {
              userID: referral.inviteeID,
              friendID: { not: referral.inviterID },
            },
            {
              friendID: referral.inviteeID,
              userID: { not: referral.inviterID },
            },
          ],
        },
        select: { id: true },
      });
      if (!acceptedFriend) {
        await this.deferPending(tx, referral.id, referral.expiresAt, now);
        return { kind: 'pending' };
      }

      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const nextMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );
      const rewardedThisMonth = await tx.referral.count({
        where: {
          inviterID: referral.inviterID,
          status: 'REWARDED',
          rewardedAt: { gte: monthStart, lt: nextMonth },
        },
      });
      if (rewardedThisMonth >= this.rules.monthlyCap) {
        await tx.referral.update({
          where: { id: referral.id },
          data: {
            status: 'CAPPED',
            qualifiedAt: now,
            failureReason: 'MONTHLY_CAP_REACHED',
          },
        });
        return { kind: 'capped' };
      }

      await this.coins.creditInTransaction(tx, {
        userId: referral.inviterID,
        amount: referral.inviterReward,
        type: 'REFERRAL_REWARD',
        note: '邀请好友奖励',
        relatedId: referral.id,
        idempotencyKey: `referral:inviter:${referral.id}`,
      });
      await this.coins.creditInTransaction(tx, {
        userId: referral.inviteeID,
        amount: referral.inviteeReward,
        type: 'REFERRAL_BONUS',
        note: '受邀注册奖励',
        relatedId: referral.id,
        idempotencyKey: `referral:invitee:${referral.id}`,
      });
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          status: 'REWARDED',
          qualifiedAt: now,
          rewardedAt: now,
          failureReason: null,
        },
      });
      return {
        kind: 'rewarded',
        inviterId: referral.inviterID,
        inviteeId: referral.inviteeID,
        inviterReward: referral.inviterReward,
        inviteeReward: referral.inviteeReward,
      };
    });
  }

  private async notifyReward(settlement: RewardedSettlement): Promise<void> {
    await Promise.all([
      this.notifyUser(
        settlement.inviterId,
        settlement.inviterReward,
        `邀请奖励已到账 ${settlement.inviterReward} 积分`,
        'REFERRAL_REWARD',
      ),
      this.notifyUser(
        settlement.inviteeId,
        settlement.inviteeReward,
        `受邀注册奖励已到账 ${settlement.inviteeReward} 积分`,
        'REFERRAL_BONUS',
      ),
    ]);
  }

  private async deferPending(
    tx: Prisma.TransactionClient,
    referralId: string,
    expiresAt: Date,
    now: Date,
  ): Promise<void> {
    const proposed = new Date(now.getTime() + REFERRAL_RECHECK_MS);
    await tx.referral.update({
      where: { id: referralId },
      data: { nextCheckAt: proposed < expiresAt ? proposed : expiresAt },
    });
  }

  private async notifyUser(
    userId: string,
    amount: number,
    content: string,
    reason: string,
  ): Promise<void> {
    try {
      const notification = await this.notifications.createSystemNotification(
        userId,
        userId,
        content,
      );
      await this.realtime.safeBroadcastAll([
        () =>
          this.realtime.broadcastWalletBalanceChanged(userId, {
            reason,
            delta: amount,
          }),
        ...(notification
          ? [
              () =>
                this.realtime.broadcastNotificationCreated(
                  userId,
                  notification,
                ),
            ]
          : []),
        () => this.realtime.broadcastSystemNotificationUnread(userId),
      ]);
    } catch (error) {
      this.logger.warn(
        `Referral reward notification failed for a credited account: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
