import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  mapNotificationRealtimeDto,
  NOTIFICATION_REALTIME_INCLUDE,
} from './notification.dto';
import {
  DELIVERY_MAX_ATTEMPTS,
  NotificationPushService,
  type ExpoPushPayload,
} from './notification-push.service';

const BATCH_SIZE = 100;
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Push outbox 处理器（#88 重构后）。
 *
 * 旧行为的两处硬伤：outbox 只有整通知一行，部分 token 失败 → 整通知重发 →
 * 已收到的设备吃重复推送；且发送时重读活的 Notification 行。现在：
 * - 每 (notification, token) 一条 NotificationPushDelivery 投递行，重试只补发
 *   仍处 PENDING/FAILED 的 token；SENT/CONFIRMED/TERMINAL 永不重推。
 * - payload 在第一次处理时组装并快照进 outbox.payload，之后的重试原样重发。
 * - Expo ticket id 落在投递行上，异步回执由 NotificationPushService.pollReceipts
 *   消费（死令牌 reap / 可重试错误把 outbox 拉回 PENDING）。
 */
@Injectable()
export class NotificationPushOutboxProcessor {
  private readonly logger = new Logger(NotificationPushOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: NotificationPushService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processPending(): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const jobs = await this.prisma.notificationPushOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      include: { notification: { include: NOTIFICATION_REALTIME_INCLUDE } },
    });
    let processed = 0;
    for (const job of jobs) {
      const claimNow = new Date();
      const claimStaleBefore = new Date(claimNow.getTime() - STALE_LOCK_MS);
      const leaseToken = randomUUID();
      const claimed = await this.prisma.notificationPushOutbox.updateMany({
        where: {
          id: job.id,
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', nextAttemptAt: { lte: claimNow } },
            {
              status: 'PROCESSING',
              lockedAt: { lt: claimStaleBefore },
            },
          ],
        },
        data: {
          status: 'PROCESSING',
          leaseToken,
          lockedAt: claimNow,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) continue;
      try {
        const userId = job.notification.toUserID ?? '';

        // payload 快照：第一次组装后固化，重试永远发「当初组装的那份」。
        let payload = job.payload as ExpoPushPayload | null;
        if (!payload || typeof payload.title !== 'string') {
          payload = this.pushService.composeMessage(
            userId,
            mapNotificationRealtimeDto(job.notification),
          );
          await this.prisma.notificationPushOutbox.updateMany({
            where: { id: job.id, leaseToken },
            // Prisma Json 列入参要求 InputJsonValue；payload 本身就是纯 JSON。
            data: { payload: JSON.parse(JSON.stringify(payload)) },
          });
        }

        // 为当前活跃 token 惰性建投递行（幂等：唯一键 + skipDuplicates）。
        // 注册于「创建后、本次重试前」的新设备也能被补上。
        const tokens = await this.pushService.listActiveTokens(userId);
        if (tokens.length > 0) {
          await this.prisma.notificationPushDelivery.createMany({
            data: tokens.map((row) => ({
              outboxID: job.id,
              notificationID: job.notificationID,
              token: row.token,
            })),
            skipDuplicates: true,
          });
        }

        // 只发仍待投的行 —— 这是「部分失败不再殃及已送达设备」的关键。
        const retriableDeliveries =
          await this.prisma.notificationPushDelivery.findMany({
            where: {
              outboxID: job.id,
              status: { in: ['PENDING', 'FAILED'] },
              attempts: { lt: DELIVERY_MAX_ATTEMPTS },
            },
            select: { id: true, token: true },
          });

        // review 修复（P1）：投递行存的是裸 token 快照 —— 用户登出删除 /
        // token 被 upsert 到别的账号后，重试会把通知推给已登出设备或别人。
        // 每次补发前都对照收件人「当前活跃」token 集，出圈的行直接终态。
        const activeTokenSet = new Set(tokens.map((row) => row.token));
        const revoked = retriableDeliveries.filter(
          (delivery) => !activeTokenSet.has(delivery.token),
        );
        if (revoked.length > 0) {
          await this.prisma.notificationPushDelivery.updateMany({
            where: { id: { in: revoked.map((delivery) => delivery.id) } },
            data: { status: 'TERMINAL', lastError: 'token-revoked' },
          });
        }
        const pendingDeliveries = retriableDeliveries.filter((delivery) =>
          activeTokenSet.has(delivery.token),
        );

        if (pendingDeliveries.length === 0) {
          // review 修复：还有 FAILED 但重试次数打光的行时，这个 job 不是
          // 「完成」而是「死信」——标 TERMINAL 让积压对运维可见（Expo 长停
          // 期间静默 COMPLETED 等于把丢推送藏起来）。
          // round 3：但只要还有 SENT 行在等回执就不能 TERMINAL —— 回执轮询
          // 只会把 COMPLETED 的 outbox 拉回 PENDING，TERMINAL 会把这些行的
          // 可重试回执失败永久冻住。等回执全部落定后的下一轮 sweep 再定性。
          const [exhausted, awaitingReceipt] = await Promise.all([
            this.prisma.notificationPushDelivery.count({
              where: {
                outboxID: job.id,
                status: 'FAILED',
                attempts: { gte: DELIVERY_MAX_ATTEMPTS },
              },
            }),
            this.prisma.notificationPushDelivery.count({
              where: { outboxID: job.id, status: 'SENT' },
            }),
          ]);
          await this.finishJob(
            job.id,
            leaseToken,
            exhausted > 0 && awaitingReceipt === 0 ? 'TERMINAL' : 'COMPLETED',
          );
          processed += 1;
          continue;
        }

        const projectByToken = new Map(
          tokens.map((row) => [row.token, row.projectId]),
        );
        const outcomes = await this.pushService.sendToTokens(
          pendingDeliveries.map((delivery) => ({
            token: delivery.token,
            projectId: projectByToken.get(delivery.token) ?? null,
          })),
          payload,
        );

        const deliveryByToken = new Map(
          pendingDeliveries.map((delivery) => [delivery.token, delivery.id]),
        );
        const sentAt = new Date();
        let retryable = 0;
        for (const outcome of outcomes) {
          const deliveryId = deliveryByToken.get(outcome.token);
          if (!deliveryId) continue;
          if (outcome.status === 'SENT') {
            await this.prisma.notificationPushDelivery.update({
              where: { id: deliveryId },
              data: {
                status: 'SENT',
                ticketID: outcome.ticketId ?? null,
                sentAt,
                attempts: { increment: 1 },
                lastError: null,
              },
            });
          } else if (outcome.status === 'TERMINAL') {
            await this.prisma.notificationPushDelivery.update({
              where: { id: deliveryId },
              data: {
                status: 'TERMINAL',
                attempts: { increment: 1 },
                lastError: (outcome.error ?? 'terminal').slice(0, 1000),
              },
            });
          } else {
            retryable += 1;
            await this.prisma.notificationPushDelivery.update({
              where: { id: deliveryId },
              data: {
                status: 'FAILED',
                attempts: { increment: 1 },
                lastError: (outcome.error ?? 'retryable').slice(0, 1000),
              },
            });
          }
        }

        if (retryable > 0) {
          throw new RetryableDeliveryError(
            `${retryable}/${outcomes.length} token deliveries retryable`,
          );
        }
        await this.finishJob(job.id, leaseToken, 'COMPLETED');
        processed += 1;
      } catch (error) {
        const attempts = job.attempts + 1;
        await this.prisma.notificationPushOutbox.updateMany({
          where: { id: job.id, leaseToken, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            lockedAt: null,
            leaseToken: null,
            lastError: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 1000),
            nextAttemptAt: new Date(
              Date.now() +
                Math.min(60 * 60 * 1000, 2 ** Math.min(attempts, 10) * 1000),
            ),
          },
        });
        if (!(error instanceof RetryableDeliveryError)) {
          this.logger.warn(`Push outbox job ${job.id} failed: ${error}`);
        }
      }
    }
    return processed;
  }

  private async finishJob(
    jobId: string,
    leaseToken: string,
    status: 'COMPLETED' | 'TERMINAL',
  ): Promise<void> {
    await this.prisma.notificationPushOutbox.updateMany({
      where: { id: jobId, leaseToken, status: 'PROCESSING' },
      data: {
        status,
        processedAt: new Date(),
        lockedAt: null,
        leaseToken: null,
        lastError: null,
      },
    });
  }
}

/** 部分 token 可重试失败：走 outbox 退避重试，但不值得按异常告警。 */
class RetryableDeliveryError extends Error {}
