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
import {
  REFERRAL_BATCH_SIZE,
  REFERRAL_RECHECK_MS,
  REFERRAL_SETTLEMENT_GRACE_MS,
  REFERRAL_SWEEP_BUDGET_MS,
  REFERRAL_SWEEP_MAX_BATCHES,
} from './referral.constants';
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
    const startedAt = Date.now();

    this.sweepInFlight = true;
    let firstError: unknown = null;
    let processed = 0;
    let truncated = false;
    // 抛错的行不会推进 nextCheckAt,不排掉的话下一批会把它们原样再抽一遍,
    // 排空循环就变成了对同一批坏行的重试风暴。
    const stuck: string[] = [];
    try {
      // 一批抽完就停的话,吞吐被钉死在 BATCH_SIZE/小时:每条还没达成条件的
      // 担保关系每 6 小时就回到队列一次,几百条长期不达标的就能把每天的额度
      // 吃光,真正达标的排在后面等到 expiresAt 之后才被看到。所以要连抽到
      // 抽空为止,只用运行预算封顶(每一趟 settleOne 要么让 nextCheckAt 前进、
      // 要么把状态落终态,due 集合单调变小,循环必然收敛)。
      for (let batch = 0; batch < REFERRAL_SWEEP_MAX_BATCHES; batch += 1) {
        const due = await this.prisma.referral.findMany({
          where: {
            status: 'PENDING',
            nextCheckAt: { lte: now },
            ...(stuck.length > 0 ? { id: { notIn: stuck } } : {}),
          },
          select: { id: true },
          orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
          take: REFERRAL_BATCH_SIZE,
        });
        if (due.length === 0) break;

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
            stuck.push(id);
            this.logger.error(
              `Referral settlement failed for ${id}`,
              error instanceof Error ? error.stack : String(error),
            );
          }
        }
        processed += due.length;

        if (due.length < REFERRAL_BATCH_SIZE) break;
        if (Date.now() - startedAt >= REFERRAL_SWEEP_BUDGET_MS) {
          truncated = true;
          break;
        }
        if (batch === REFERRAL_SWEEP_MAX_BATCHES - 1) truncated = true;
      }

      if (firstError) throw firstError;
      if (processed > 0) {
        this.logger.log(
          `Referral sweep processed ${processed}: ${JSON.stringify(totals)}`,
        );
      }
      // 没抽空就说明还有欠账:必须说出来,否则「跑完了」和「跑到一半没时间了」
      // 在日志里长得一模一样。
      if (truncated) {
        this.logger.warn(
          `Referral sweep hit its budget after ${processed} rows; more remain due`,
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

      // 判过期之前先看条件:定时器整点跑,而 deferPending 会把终检夹到
      // expiresAt,那一检必然落在 expiresAt 之后一点点。先判过期的话,窗口
      // 最后一段时间里补了头像 / 加到第一个好友的人会被判 EXPIRED —— 明明
      // 是我们自己晚到了。所以过期只作为「条件没达成」的收尾,并给一个覆盖
      // 定时器节拍的宽限;超出宽限仍未达成才算真过期。
      const expired = now.getTime() >= referral.expiresAt.getTime();
      const graceExhausted =
        now.getTime() >=
        referral.expiresAt.getTime() + REFERRAL_SETTLEMENT_GRACE_MS;
      const failWindow = async () => {
        await tx.referral.update({
          where: { id: referral.id },
          data: {
            status: 'EXPIRED',
            failureReason: 'QUALIFICATION_WINDOW_EXPIRED',
          },
        });
      };
      if (graceExhausted) {
        await failWindow();
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
        if (expired) {
          await failWindow();
          return { kind: 'expired' };
        }
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
        if (expired) {
          await failWindow();
          return { kind: 'expired' };
        }
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
