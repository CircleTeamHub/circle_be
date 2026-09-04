import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
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
import { reportOperationalError } from 'src/logging/error-aggregation.service';

const BATCH_SIZE = 100;
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * 一次 tick 里，同一个发送者最多占多少个投递名额。
 *
 * 为什么需要这个：出队是 BATCH_SIZE 条/分钟，而一次发圈帖扇出上限 500 人
 * （CIRCLE_POST_PUBLISH_FANOUT_CAP），发帖接口限流是 40 次/15 分钟/IP —— 单个账号
 * 就能以约 1300 条/分钟往队列里灌，比出队快 13 倍。队列按 createdAt 升序取，于是
 * 正常推送（好友请求、评论回复、系统通知）全部排在洪水后面：脚本跑十分钟就能买到
 * 约两小时的全站推送黑屏。
 *
 * 公平调度只改「先发谁」，不提高发送速率 —— 对推送服务商的压力一点没变，因此不存在
 * 被上游限流或封禁的风险。攻击者仍会占满自己的配额，但吃不掉别人的。
 */
const MAX_PER_SENDER_PER_TICK = 10;
/**
 * 系统公告一轮的名额，独立于发送者配额。
 *
 * 公告扇出给每个活跃用户建一行，而这些行的 fromUserID 全是同一个管理员，落进
 * 发送者配额里就是「整条公告共用 10 条/轮」—— 10000 人的公告要发约 17 小时。
 * 但公告不是发送者洪水：每一行的收件人都不同，管理员也不是要防的那个角色，
 * 拿发送者配额去套它属于误伤。
 *
 * 所以公告改成**按公告 ID 分区**（同一管理员发的两条公告互不挤占），并给一份
 * 更宽的名额。上限仍然存在而不是完全豁免 —— 豁免的话一条大公告会吃满整批
 * BATCH_SIZE，把好友请求、评论回复挤到公告发完为止，等于把饿死方向调了个头。
 * 取 BATCH_SIZE 的一半：公告按 50 条/轮走，另外一半永远留给日常推送。
 */
const SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK = BATCH_SIZE / 2;
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

  @TrackedCron(CronExpression.EVERY_MINUTE, 'notification_push_outbox')
  async processPending(): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    // 名额分配必须跨**整个**待发队列做,不能先按 createdAt 取一个窗口再在窗口里调度。
    // 取窗口的话洪水本身就把窗口占满了:一个发送者灌 13000 条之后再来一条正常推送,
    // 每一轮的候选窗口里都只有洪水发送者,公平调度每分钟只挪走 10 条 ——
    // 那条正常推送要等约 22 小时,比改之前的纯 FIFO 还慢。
    // 用 PARTITION BY 按发送者分组排名,每人每轮最多 MAX_PER_SENDER_PER_TICK 条,
    // 再按名次(而不是时间)取前 BATCH_SIZE —— 名次相同的按时间,于是「每个人的第一条」
    // 一定先于「任何人的第二条」,新来的发送者立刻能挤进这一轮。
    const ranked = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH eligible AS (
        SELECT
          o."id",
          o."createdAt",
          (n."systemAnnouncementID" IS NOT NULL) AS is_announcement,
          ROW_NUMBER() OVER (
            PARTITION BY CASE
              WHEN n."systemAnnouncementID" IS NOT NULL
                THEN 'announcement:' || n."systemAnnouncementID"
              ELSE 'sender:' || n."fromUserID"
            END
            ORDER BY o."createdAt" ASC, o."id" ASC
          ) AS rn
        FROM "NotificationPushOutbox" AS o
        JOIN "Notification" AS n ON n."id" = o."notificationID"
        WHERE (o."status" = 'PENDING' AND o."nextAttemptAt" <= ${now})
           OR (o."status" = 'FAILED' AND o."nextAttemptAt" <= ${now})
           OR (o."status" = 'PROCESSING' AND o."lockedAt" < ${staleBefore})
      )
      SELECT "id"
      FROM eligible
      -- 两个分支都是绑定参数,不显式转型的话 Postgres 推不出 CASE 的结果类型
      -- (两侧都是 unknown),会直接报 could not determine data type。
      WHERE rn <= CASE
        WHEN is_announcement THEN ${SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK}::int
        ELSE ${MAX_PER_SENDER_PER_TICK}::int
      END
      ORDER BY rn ASC, "createdAt" ASC, "id" ASC
      LIMIT ${BATCH_SIZE}
    `;
    if (ranked.length === 0) return 0;
    const order = new Map(ranked.map((row, index) => [row.id, index]));
    const hydrated = await this.prisma.notificationPushOutbox.findMany({
      where: { id: { in: ranked.map((row) => row.id) } },
      include: { notification: { include: NOTIFICATION_REALTIME_INCLUDE } },
    });
    // findMany 不保证顺序,而这一批的顺序就是公平性本身,按名次重排回去。
    const jobs = hydrated.sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
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
          const finalStatus =
            exhausted > 0 && awaitingReceipt === 0 ? 'TERMINAL' : 'COMPLETED';
          if (finalStatus === 'TERMINAL') {
            // 死信：重试已打光,这条通知再也不会送达。指标看得到积压,这里让
            // 错误聚合也看到(按签名 60s 去重,洪水期间不会刷屏)。
            reportOperationalError(
              new Error('push outbox job exhausted delivery retries'),
              {
                component: 'NotificationPushOutboxProcessor',
                operation: 'processPending',
                kind: 'terminal',
              },
            );
          }
          await this.finishJob(job.id, leaseToken, finalStatus);
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
          reportOperationalError(error, {
            component: 'NotificationPushOutboxProcessor',
            operation: 'processJob',
            kind: 'delivery',
          });
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
