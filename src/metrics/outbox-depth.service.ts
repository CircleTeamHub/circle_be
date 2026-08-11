import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GIFT_CARD_MAX_ATTEMPTS } from '../coin/gift-card-outbox.processor';
import { VERIFICATION_CARD_MAX_ATTEMPTS } from '../circle-invitation/circle-invitation.service';
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
  circleInvitationVerifier: OutboxDelegateLike;
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
 * - verification_card：circleInvitationVerifier 上的虚拟队列（#147 引入）。
 *   schema 注释写明它与 CoinGift 的 cardDeliveredAt/cardAttempts **同构**；
 *   差别是这张卡之外还有站内通知和待验证列表两条通道，所以它的死信不像
 *   gift_card 那样是「钱已结算却没有任何凭证」，走通用 warning 而非 critical。
 *   待处理条件必须与 sweepUndeliveredVerificationCards 完全一致（含父邀请仍
 *   PENDING 这一条），否则指标会把补偿任务根本不会碰的行算成积压。
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
    name: 'verification_card',
    model: 'circleInvitationVerifier',
    pendingWhere: {
      status: 'PENDING',
      invitation: { is: { status: 'PENDING' } },
      cardDeliveredAt: null,
      cardAttempts: { lt: VERIFICATION_CARD_MAX_ATTEMPTS },
    },
    deadWhere: {
      status: 'PENDING',
      invitation: { is: { status: 'PENDING' } },
      cardDeliveredAt: null,
      cardAttempts: { gte: VERIFICATION_CARD_MAX_ATTEMPTS },
    },
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
 *
 * 刻意**串行**跑，一次只占一个连接。并发版本（外层 Promise.all 5 个队列 ×
 * 内层 pending/dead 两查）在每个整分钟同时开 8 个连接，而池默认只有 10、
 * 其余 EVERY_MINUTE 的处理器又都在同一个边界点火 —— 一张变大的 outbox 表
 * 或一次慢查询，就足以让这个**纯观测**任务把池吃干净、把真实请求排到
 * 10 秒获取超时上。观测代码抢生产流量的连接是本末倒置；这里的代价只是
 * 几个 count 从并行变串行，探测周期是 60 秒，完全付得起。
 */
export const OUTBOX_PROBE_MAX_CONCURRENT_QUERIES = 1;

export async function collectOutboxDepths(
  prisma: OutboxDepthSource,
  now: Date,
): Promise<OutboxDepthSample[]> {
  const samples: OutboxDepthSample[] = [];

  for (const queue of OUTBOX_QUEUES) {
    const delegate = prisma[queue.model];
    try {
      const pending = await delegate.aggregate({
        where: queue.pendingWhere,
        _count: { _all: true },
        _min: { createdAt: true },
      });
      const dead = queue.deadWhere
        ? await delegate.count({ where: queue.deadWhere })
        : 0;

      const oldest = pending._min.createdAt;
      samples.push({
        queue: queue.name,
        pending: pending._count._all,
        // 下限 0：多实例时钟漂移下 createdAt 可能落在 now 之后，负数会让
        // `> 阈值` 的积压告警变成永远打不中。
        oldestAgeSeconds: oldest
          ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000))
          : 0,
        dead,
      });
    } catch (error) {
      // 继续跑下一个队列 —— 一张表锁住不该让其余队列的读数一起消失。
      logger.warn(
        `Failed to probe outbox depth for ${queue.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return samples;
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
  constructor(private readonly prisma: PrismaService) {
    // 播种每个队列的「上次成功探测时刻」。不播种的话，一个从开机起探测就一直
    // 失败的队列压根没有序列，OutboxProbeStale 反而永远不响 —— 与心跳播种
    // 同一个理由。
    for (const queue of OUTBOX_QUEUES) {
      jobMetrics.registerOutboxQueue(queue.name);
    }
  }

  @TrackedCron(CronExpression.EVERY_MINUTE, 'outbox_depth_probe')
  async refresh(now: Date = new Date()): Promise<number> {
    // Prisma 生成的 delegate 类型是重载泛型，结构上无法直接赋给窄接口；
    // 在这一个边界上收敛这次转换，其余代码只见 OutboxDepthSource。
    const samples = await collectOutboxDepths(
      this.prisma as unknown as OutboxDepthSource,
      now,
    );
    for (const sample of samples) {
      // 只有真读到数才推进新鲜度；失败的队列时间戳停住，由 OutboxProbeStale
      // 发现「这个队列的数字已经不可信」—— 单队列失败不影响其它队列这一点
      // 保持不变（那正是它当初被吞掉的原因）。
      jobMetrics.setOutboxDepth(sample, now.getTime());
    }
    return samples.length;
  }
}
