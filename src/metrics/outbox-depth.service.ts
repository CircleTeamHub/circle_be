import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GIFT_CARD_MAX_ATTEMPTS } from '../coin/gift-card-outbox.processor';
import { jobMetrics, type OutboxDepthSample } from './job-metrics';
import { TrackedCron } from './tracked-cron.decorator';

/** aggregate/count 的最小切面 —— 让测试能注入假 delegate。 */
export interface OutboxDelegateLike {
  aggregate(args: {
    where?: unknown;
    _count: { _all: true };
    _min: { createdAt: true };
  }): Promise<{ _count: { _all: number }; _min: { createdAt: Date | null } }>;
  count(args: { where?: unknown }): Promise<number>;
}

export interface OutboxDepthSource {
  sessionRevocationOutbox: OutboxDelegateLike;
  notificationPushOutbox: OutboxDelegateLike;
  friendChatReplayOutbox: OutboxDelegateLike;
  coinGift: OutboxDelegateLike;
}

interface OutboxQueueSpec {
  /** Prometheus 的 `queue` 标签值。 */
  name: string;
  /** 读哪张表。 */
  model: keyof OutboxDepthSource;
  /** 仍会被重试的行。 */
  pendingWhere: unknown;
  /**
   * 已放弃、不会再被重试的行。留空表示该队列没有终态 —— 不要为了「对称」
   * 编一个出来，那只会让一条永远为 0 的告警训练人忽略它。
   */
  deadWhere?: unknown;
}

/**
 * 队列清单。每张表的「待处理」定义必须与它自己的处理器一致，否则指标会和
 * 实际行为分叉：
 *
 * - session_revocation：处理成功即删行，所以在表里 = 待处理。过期行由处理器
 *   删除，一条过期还在的行说明处理器没在跑 —— pending + age 已经能看出来，
 *   不另设终态。
 * - notification_push：FAILED 是**可重试**态（`nextAttemptAt <= now` 会被重新
 *   领取），TERMINAL 才是死信。处理器注释写着标 TERMINAL 是为了「让积压对运维
 *   可见」—— 在此之前没有任何东西在看它，这个 gauge 就是那个观察者。
 * - friend_chat_replay：FAILED 同样可重试，且没有尝试上限（指数退避重试到底），
 *   所以没有死信态。
 * - gift_card：coinGift 上的虚拟队列。处理器有 2 分钟宽限期才补发，所以稳态下
 *   oldestAge 会在 ~120s 附近浮动 —— 告警阈值必须显著高于它。
 */
export const OUTBOX_QUEUES: readonly OutboxQueueSpec[] = [
  {
    name: 'session_revocation',
    model: 'sessionRevocationOutbox',
    pendingWhere: undefined,
  },
  {
    name: 'notification_push',
    model: 'notificationPushOutbox',
    pendingWhere: { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
    deadWhere: { status: 'TERMINAL' },
  },
  {
    name: 'friend_chat_replay',
    model: 'friendChatReplayOutbox',
    pendingWhere: { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
  },
  {
    name: 'gift_card',
    model: 'coinGift',
    pendingWhere: {
      cardDeliveredAt: null,
      cardAttempts: { lt: GIFT_CARD_MAX_ATTEMPTS },
    },
    deadWhere: {
      cardDeliveredAt: null,
      cardAttempts: { gte: GIFT_CARD_MAX_ATTEMPTS },
    },
  },
];

const logger = new Logger('OutboxDepth');

/**
 * 采集一轮队列深度。**单个队列失败只丢它自己**：整轮 reject 会让所有队列的
 * 序列一起消失（迁移中、单表锁等待都可能触发），积压告警随之集体静默。
 */
export async function collectOutboxDepths(
  prisma: OutboxDepthSource,
  now: Date,
): Promise<OutboxDepthSample[]> {
  const results = await Promise.all(
    OUTBOX_QUEUES.map(async (queue) => {
      const delegate = prisma[queue.model];
      try {
        const [pending, dead] = await Promise.all([
          delegate.aggregate({
            where: queue.pendingWhere,
            _count: { _all: true },
            _min: { createdAt: true },
          }),
          queue.deadWhere
            ? delegate.count({ where: queue.deadWhere })
            : Promise.resolve(0),
        ]);

        const oldest = pending._min.createdAt;
        return {
          queue: queue.name,
          pending: pending._count._all,
          // 下限 0：多实例时钟漂移下 createdAt 可能落在 now 之后，负数会让
          // `> 阈值` 的积压告警变成永远打不中。
          oldestAgeSeconds: oldest
            ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000))
            : 0,
          dead,
        } satisfies OutboxDepthSample;
      } catch (error) {
        logger.warn(
          `Failed to probe outbox depth for ${queue.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return undefined;
      }
    }),
  );

  return results.filter((sample): sample is OutboxDepthSample =>
    Boolean(sample),
  );
}

/**
 * 把 4 个 outbox 队列的深度刷进 gauge。
 *
 * 刻意**不**在 gauge 的 `collect()` 里查库（infra-status 那种抓取时求值的写法
 * 在这里是错的）：DB 慢或挂掉时，抓取会一起卡住直到 scrape 超时，于是整个
 * `/metrics` 变成不可用 —— 恰好在数据库事故期间，把 RED、事件循环、chat 延迟
 * 这些最需要看的指标一并弄丢。改成定时刷新 + gauge 只报最近一次读数，`/metrics`
 * 的延迟就与 DB 健康完全解耦。
 *
 * 刷新任务自己也是 TrackedCron：它要是停了，
 * `circle_cron_last_success_timestamp_seconds{job="outbox_depth_probe"}` 会变陈旧，
 * 心跳告警照样响 —— 所以「指标停止更新」这件事本身也是被监控的。
 */
@Injectable()
export class OutboxDepthService {
  constructor(private readonly prisma: PrismaService) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'outbox_depth_probe')
  async refresh(now: Date = new Date()): Promise<number> {
    // Prisma 生成的 delegate 类型是重载泛型，结构上无法直接赋给窄接口；
    // 在这一个边界上收敛这次转换，其余代码只见 OutboxDepthSource。
    const samples = await collectOutboxDepths(
      this.prisma as unknown as OutboxDepthSource,
      now,
    );
    for (const sample of samples) {
      jobMetrics.setOutboxDepth(sample);
    }
    return samples.length;
  }
}
