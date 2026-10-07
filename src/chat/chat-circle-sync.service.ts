import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  reportJobSkipped,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { JobLeaseContext, runWithJobLease } from 'src/redis/job-lease';
import { RedisService } from 'src/redis/redis.service';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatGroupEventService } from './chat-group-event.service';
import { ChatSystemMessageService } from './chat-system-message.service';
import { sanitizeLogValue } from '../logging/log-sanitizer';
import { attemptDiagnostic } from '../logging/http-failure.logger';

/**
 * 不再持有群聊的管理态。DISABLING/RESTORING 也算在内:处理中的圈子
 * 默认拒绝(宁可晚一分钟恢复,也不要在停用窗口里把门开着)。
 */
/** 圈子座位对账的 advisory lock 命名空间(与 chat 的其它锁不撞)。 */
export const CIRCLE_SYNC_LOCK_NAMESPACE = 7302;

const DISABLED_ADMIN_STATES = new Set<string>([
  'DISABLING',
  'DISABLED',
  'RESTORING',
  'SYNC_FAILED',
  'DISMISSED',
]);

type CircleSyncScanCursor = {
  windowSince: string;
  updatedAt: string;
  circleID: string;
};

type CircleSyncScanRow = {
  circleID: string;
  updatedAt: Date;
};

function safePrismaCode(error: unknown): string | undefined {
  const code =
    error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value
      : undefined;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : undefined;
}

/**
 * 圈子成员 ←→ 群会话座位的同步(自研聊天版的 group-sync)。
 *
 * 机制:幂等 ensure + 定时对账 + 两类主动触发:
 * - 删除写点(踢人/退群/退圈)在事务内 releaseSeatInTx + 提交后 detachSeat ——
 *   对账的 updatedAt 窗口永远看不见被删的行,这类只能靠钩子;
 * - 激活写点(建圈/开圈聊/拉人进群/入圈获批)提交后尽力而为调 ensure,
 *   新成员即刻入座;失败由每分钟对账兜底
 *   (CircleMember.updatedAt 窗口扫描,与 like-reconciliation 同款模式)。
 * 座位变化会经 chat:conversation 个人事件通知本人(见 ChatBroadcastService)。
 */
@Injectable()
export class ChatCircleSyncService {
  private readonly logger = new Logger(ChatCircleSyncService.name);

  /** 对账扫描窗口:2 个周期重叠,防止边界上的变更漏扫。 */
  private static readonly RECONCILE_WINDOW_MS = 2 * 60_000;
  /** 单轮扫描上限；超过后按 (updatedAt,circleID) 游标续扫。 */
  private static readonly RECONCILE_SCAN_MAX = 10_000;
  private static readonly RECONCILE_LEASE_KEY = 'job-lease:chat_circle_sync';
  private static readonly RECONCILE_CURSOR_KEY = 'job-cursor:chat_circle_sync';
  // A 10,000-row page is normally drained in one tick, but a write burst can
  // span many ticks. Keep the shared cursor long enough to finish a large
  // backlog instead of expiring back to the moving two-minute window.
  private static readonly RECONCILE_CURSOR_TTL_SECONDS = 24 * 60 * 60;
  private static readonly RETRY_QUEUE_MAX = 1000;
  /**
   * 多实例时只让一个实例扫窗口。要短于扫描周期:持有者崩溃后租约若残留超过
   * 2 分钟窗口,期间的成员变更会滑出窗口、再也扫不到。
   */
  private static readonly RECONCILE_LEASE_MS = 50_000;

  /**
   * 即时同步失败先放进内存队列；租约持有者把对账失败持久化到重试表。
   * 扫描游标与失败队列独立，单圈故障不会阻塞后续页面。
   */
  private readonly retryQueue = new Set<string>();
  /** Redis 不可用时的单实例兜底；Redis 可用时以共享游标为准。 */
  private scanCursor: CircleSyncScanCursor | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly systemMessage: ChatSystemMessageService,
    private readonly groupEvents: ChatGroupEventService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 把一个圈子排进下一轮对账重试。
   *
   * 给对账**之外**触发的即时同步用(入圈通过后的那次 ensureCircleConversation)。
   * 那条路径失败只记日志的话:数据库正好在停机,而对账扫的是
   * `CircleMember.updatedAt` 的 2 分钟窗口 —— 库恢复时那次变更早就滑出窗口,
   * 于是这位新成员的聊天座位一直缺着,直到该圈碰巧再发生一次成员变更。
   */
  scheduleRetry(circleID: string): void {
    if (this.retryQueue.size >= ChatCircleSyncService.RETRY_QUEUE_MAX) return;
    this.retryQueue.add(circleID);
  }

  @TrackedCron(CronExpression.EVERY_MINUTE, 'chat_circle_sync')
  async reconcileRecent(): Promise<void> {
    const since = new Date(
      Date.now() - ChatCircleSyncService.RECONCILE_WINDOW_MS,
    );
    // 窗口扫描按 updatedAt 找变更,各实例扫的是同一份数据:只让租约持有者扫。
    const leased = await runWithJobLease(
      this.redis,
      'chat_circle_sync',
      ChatCircleSyncService.RECONCILE_LEASE_MS,
      async (leaseToken, lease) => {
        let scan: {
          circleIds: string[];
          nextCursor: CircleSyncScanCursor | null;
        };
        try {
          scan = await this.scanChangedCircles(since, leaseToken);
        } catch (error) {
          attemptDiagnostic(() =>
            this.logger.error(
              sanitizeLogValue({
                event: 'chat_circle_sync_failed',
                operation: 'reconcile_scan',
                errorCode: safePrismaCode(error),
                error,
              }),
            ),
          );
          // 扫描失败 = 这一轮一个圈子都没对账。不上报的话包装器会记成成功。
          reportHandledJobFailure();
          return;
        }
        if (!scan) {
          reportJobSkipped();
          return;
        }
        // Checkpoint failures in PostgreSQL before advancing the scan. A
        // permanently failing circle must not strand later membership pages.
        try {
          if (!(await this.reconcileCircles(scan.circleIds, true, lease))) {
            reportJobSkipped();
            return;
          }
          if (!(await this.writeScanCursor(scan.nextCursor, leaseToken)))
            reportJobSkipped();
        } catch (error) {
          reportHandledJobFailure();
          attemptDiagnostic(() =>
            this.logger.error(
              sanitizeLogValue({
                event: 'chat_circle_sync_failed',
                operation: 'reconcile_checkpoint',
                error,
              }),
            ),
          );
        }
      },
    );
    if (leased) return;
    // 别的实例在扫窗口。重试队列只在本机内存里,只有本机知道,照常处理 ——
    // 否则排在这台机器上的失败圈子永远轮不到。
    if (this.retryQueue.size === 0) {
      reportJobSkipped();
      return;
    }
    await this.reconcileCircles([]);
  }

  private async reconcileCircles(
    changed: string[],
    includeDurable = false,
    lease?: JobLeaseContext,
  ): Promise<boolean> {
    if (lease && !lease.isCurrent()) return false;
    const attemptStartedAt = new Date();
    const durable = includeDurable
      ? await this.prisma.chatCircleSyncRetry.findMany({
          where: { nextAttemptAt: { lte: attemptStartedAt } },
          select: { circleID: true },
          orderBy: [{ nextAttemptAt: 'asc' }, { circleID: 'asc' }],
          take: ChatCircleSyncService.RETRY_QUEUE_MAX,
        })
      : [];
    // 上轮失败的圈子跟着重试:只靠窗口重叠的话,连续失败超过 2 分钟就永远
    // 掉出扫描范围,被踢成员的座位会一直留着(还能读能发)。
    const pending = [...this.retryQueue];
    this.retryQueue.clear();
    const failed: string[] = [];
    const attempted = [
      ...new Set([
        ...changed,
        ...pending,
        ...durable.map((row) => row.circleID),
      ]),
    ];
    let completed = true;
    for (const circleID of attempted) {
      if (lease && !lease.isCurrent()) {
        completed = false;
        // Local retries outside the scan window must not disappear when a
        // lease is lost before their turn. Durable rows remain in PostgreSQL.
        for (const pendingID of pending) {
          if (this.retryQueue.size < ChatCircleSyncService.RETRY_QUEUE_MAX)
            this.retryQueue.add(pendingID);
        }
        break;
      }
      try {
        await this.ensureCircleConversation(circleID);
      } catch (error) {
        failed.push(circleID);
        // 单圈失败不拖垮整轮;排进重试队列,直到成功为止。
        if (this.retryQueue.size < ChatCircleSyncService.RETRY_QUEUE_MAX) {
          this.retryQueue.add(circleID);
        }
        attemptDiagnostic(() =>
          this.logger.warn(
            sanitizeLogValue({
              event: 'chat_circle_sync_failed',
              operation: 'reconcile_circle',
              circleId: circleID,
              error,
            }),
          ),
        );
      }
    }
    if (failed.length > 0) reportHandledJobFailure();
    if (lease && !lease.isCurrent()) completed = false;
    if (includeDurable && attempted.length > 0) {
      const failedSet = new Set(failed);
      await this.prisma.$transaction(async (tx) => {
        if (failed.length > 0) {
          await tx.chatCircleSyncRetry.createMany({
            data: failed.map((circleID) => ({ circleID })),
            skipDuplicates: true,
          });
          await tx.chatCircleSyncRetry.updateMany({
            where: { circleID: { in: failed } },
            data: { nextAttemptAt: new Date(Date.now() + 60_000) },
          });
        }
        const succeeded = attempted.filter((id) => !failedSet.has(id));
        if (completed && succeeded.length > 0)
          await tx.chatCircleSyncRetry.deleteMany({
            // An overlapping newer run may have failed after this attempt
            // already reconciled an older membership snapshot. Its retry is
            // scheduled in the future and must survive this late success.
            where: {
              circleID: { in: succeeded },
              nextAttemptAt: { lte: attemptStartedAt },
            },
          });
      });
    }
    return completed;
  }

  /**
   * 窗口内发生过成员变更的圈子。按 (updatedAt,circleID) 逐批轮转，超过
   * 单轮上限时把水位写入 Redis，下一轮从上次位置继续，避免每分钟重复扫批首部。
   */
  private async scanChangedCircles(
    since: Date,
    leaseToken?: string,
  ): Promise<{
    circleIds: string[];
    nextCursor: CircleSyncScanCursor | null;
  } | null> {
    const cursor = await this.readScanCursor(since);
    const scanSince = cursor ? new Date(cursor.windowSince) : since;
    // Persist the starting window before work begins. A restart must replay
    // this page even if its rows have left the moving two-minute window.
    if (!cursor) {
      const written = await this.writeScanCursor(
        {
          windowSince: scanSince.toISOString(),
          updatedAt: scanSince.toISOString(),
          circleID: '',
        },
        leaseToken,
      );
      if (!written) return null;
    }
    const rows = cursor
      ? await this.prisma.$queryRaw<CircleSyncScanRow[]>(Prisma.sql`
          SELECT "circleID", "updatedAt"
          FROM "CircleMember"
          WHERE "updatedAt" > ${scanSince}
            AND ("updatedAt", "circleID") > (${new Date(cursor.updatedAt)}, ${cursor.circleID})
          ORDER BY "updatedAt" ASC, "circleID" ASC
          LIMIT ${ChatCircleSyncService.RECONCILE_SCAN_MAX}
        `)
      : await this.prisma.$queryRaw<CircleSyncScanRow[]>(Prisma.sql`
          SELECT "circleID", "updatedAt"
          FROM "CircleMember"
          WHERE "updatedAt" > ${scanSince}
          ORDER BY "updatedAt" ASC, "circleID" ASC
          LIMIT ${ChatCircleSyncService.RECONCILE_SCAN_MAX}
        `);

    const last = rows[rows.length - 1];
    let nextCursor: CircleSyncScanCursor | null = null;
    if (rows.length >= ChatCircleSyncService.RECONCILE_SCAN_MAX && last) {
      const updatedAt = this.parseScanTimestamp(last.updatedAt);
      if (updatedAt) {
        nextCursor = {
          windowSince: scanSince.toISOString(),
          updatedAt: updatedAt.toISOString(),
          circleID: last.circleID,
        };
      }
      this.logger.warn(
        `reconcile scan hit the ${ChatCircleSyncService.RECONCILE_SCAN_MAX}-row cap; remainder continues from the saved cursor`,
      );
    }
    return {
      circleIds: [...new Set(rows.map((row) => row.circleID))],
      nextCursor,
    };
  }

  private parseScanTimestamp(value: unknown): Date | null {
    const date = value instanceof Date ? value : new Date(String(value ?? ''));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private async readScanCursor(
    since: Date,
  ): Promise<CircleSyncScanCursor | null> {
    const shared = await this.redis.getJsonMany<unknown>(
      [ChatCircleSyncService.RECONCILE_CURSOR_KEY],
      { strict: true },
    );
    // Missing keys and legacy JSON null both decode as [null]. Retain local
    // outage progress in that ambiguous case; new completions are explicit.
    const candidate = shared?.[0] ?? this.scanCursor;
    if (
      candidate &&
      typeof candidate === 'object' &&
      'completed' in candidate &&
      candidate.completed === true
    ) {
      this.scanCursor = null;
      return null;
    }
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !('windowSince' in candidate) ||
      !('circleID' in candidate) ||
      !('updatedAt' in candidate) ||
      typeof candidate.windowSince !== 'string' ||
      typeof candidate.circleID !== 'string' ||
      typeof candidate.updatedAt !== 'string'
    ) {
      return null;
    }
    const windowSince = this.parseScanTimestamp(candidate.windowSince);
    const updatedAt = this.parseScanTimestamp(candidate.updatedAt);
    if (
      !windowSince ||
      !updatedAt ||
      windowSince > since ||
      updatedAt < windowSince
    ) {
      return null;
    }
    this.scanCursor = {
      windowSince: windowSince.toISOString(),
      updatedAt: updatedAt.toISOString(),
      circleID: candidate.circleID,
    };
    return this.scanCursor;
  }

  private async writeScanCursor(
    cursor: CircleSyncScanCursor | null,
    leaseToken?: string,
  ): Promise<boolean> {
    // A slow run can outlive its lease and finish after another holder has
    // saved a newer page/window. Fence SET (including completion) atomically
    // with the lease token, and never retain rejected progress locally.
    if (leaseToken !== undefined) {
      const written = await this.redis.setJsonIfVersionMatches(
        ChatCircleSyncService.RECONCILE_CURSOR_KEY,
        ChatCircleSyncService.RECONCILE_LEASE_KEY,
        leaseToken,
        cursor ?? { completed: true },
        ChatCircleSyncService.RECONCILE_CURSOR_TTL_SECONDS,
      );
      if (!written) return false;
    }
    // Without a lease, keep only the local outage fallback. Redis may recover
    // mid-run, but that does not grant ownership of another worker's cursor.
    this.scanCursor = cursor;
    return true;
  }

  /**
   * 幂等:确保圈子的 GROUP 会话存在,且座位与 CircleMember(ACTIVE) 对齐。
   * 返回 conversationId;圈子不存在返回 null。
   * 集合式写法(createMany skipDuplicates / 条件 updateMany),并发重入安全。
   */
  async ensureCircleConversation(circleId: string): Promise<string | null> {
    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { id: true, deleted: true, adminState: true },
    });
    if (!circle) return null;
    // 解散/停用的圈子一律默认拒绝。管理台 DISMISS 只把座位置 leftAt,
    // CircleMember 行仍是 ACTIVE —— 若照常对账,下一轮就会把 leftAt 清回去,
    // 已解散的群聊自己重新开门(建会话端点同理,它走的是同一个方法)。
    if (circle.deleted || DISABLED_ADMIN_STATES.has(circle.adminState)) {
      await this.evictAllSeats(circleId);
      return null;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 同一圈子的对账串行化。集合式写法本身是并发安全的(不会写坏数据),
      // 但**副作用**不是:两个实例同时对账同一个圈子时,双方都会在各自的
      // 快照里把同一个人算进 toJoin —— 于是 joined 事件播两遍、进群系统提示
      // 也写两条。谁先拿到锁谁做,后来者在锁后重读座位,toJoin 自然是空的。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CIRCLE_SYNC_LOCK_NAMESPACE}, hashtext(${circleId}))`;
      // The initial read is only a fast path. Recheck after taking the same
      // per-circle lock used by dissolve/disable so a concurrent state change
      // cannot let ACTIVE members re-seat into a deleted circle.
      const lockedCircle = await tx.circle.findUnique({
        where: { id: circleId },
        select: { deleted: true, adminState: true },
      });
      if (
        !lockedCircle ||
        lockedCircle.deleted ||
        DISABLED_ADMIN_STATES.has(lockedCircle.adminState)
      ) {
        return null;
      }
      let created = false;
      // clearedBeforeHeight 要一并读出来：新座位得继承它，否则「删除所有人的
      // 记录」藏起来的历史对圈子新成员整段可见。
      let conversation = await tx.chatConversation.findUnique({
        where: { circleID: circleId },
        select: { id: true, clearedBeforeHeight: true },
      });
      if (!conversation) {
        try {
          conversation = await tx.chatConversation.create({
            // 圈子成员目录只对圈主/管理员开放(review R2):「成员可查看他人资料」
            // 对圈子群默认关闭,由圈主自己决定放开。
            data: {
              type: 'GROUP',
              circleID: circleId,
              membersCanViewProfiles: false,
              membersCanViewRoster: false,
            },
            select: { id: true, clearedBeforeHeight: true },
          });
          created = true;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          conversation = await tx.chatConversation.findUnique({
            where: { circleID: circleId },
            select: { id: true, clearedBeforeHeight: true },
          });
          if (!conversation) throw error;
        }
      }

      const activeMembers = await tx.circleMember.findMany({
        where: { circleID: circleId, status: 'ACTIVE' },
        select: { userID: true },
      });
      const activeIds = activeMembers.map((m) => m.userID);
      const activeSet = new Set(activeIds);

      const seats = await tx.chatMember.findMany({
        where: { conversationID: conversation.id },
        select: { userID: true, leftAt: true },
      });
      const seatByUser = new Map(seats.map((s) => [s.userID, s]));

      const toJoin = activeIds.filter((id) => {
        const seat = seatByUser.get(id);
        return !seat || seat.leftAt !== null;
      });
      const toRemove = seats
        .filter((s) => s.leftAt === null && !activeSet.has(s.userID))
        .map((s) => s.userID);

      // 新座位的已读水位必须落在当前最高消息高度上,而不是 schema 默认的 0。
      // 落 0 的话,新入群成员一进来就背着整个群的历史未读数(老群可能是几万),
      // 红点永远清不掉;重新入群的人同理 —— 离座期间的消息本就与他无关。
      // height 只增不减,所以直接取当前最大值即可,不必逐人比大小。
      const top = await tx.chatMessage.aggregate({
        where: { conversationID: conversation.id },
        _max: { height: true },
      });
      const watermark = top._max.height ?? 0;

      await tx.chatMember.createMany({
        data: activeIds
          .filter((id) => !seatByUser.has(id))
          .map((userID) => ({
            conversationID: conversation.id,
            userID,
            lastReadHeight: watermark,
            // 这条路径不持有会话行锁（它锁的是圈子），所以继承之外读路径还按
            // max(座位, 会话) 兜底，覆盖「入座与清空并发」的窗口。
            clearedBeforeHeight: conversation.clearedBeforeHeight,
          })),
        skipDuplicates: true,
      });
      await tx.chatMember.updateMany({
        where: {
          conversationID: conversation.id,
          userID: { in: activeIds },
          leftAt: { not: null },
        },
        // joinedAt 也要重置:逐条已读回执按 joinedAt 排掉「入群前的消息」,
        // 复位座位不刷新它的话,重新入群的人会显示成他离座期间每一条消息的已读者。
        data: { leftAt: null, lastReadHeight: watermark, joinedAt: new Date() },
      });
      if (activeIds.length > 0) {
        await tx.chatMember.updateMany({
          where: {
            conversationID: conversation.id,
            userID: { notIn: activeIds },
            leftAt: null,
          },
          data: { leftAt: new Date() },
        });
      }

      return { conversationId: conversation.id, toJoin, toRemove, created };
    });

    if (!result) {
      // State changed while waiting for the lock. Evict seats after the
      // transaction commits, using the same idempotent cleanup as the fast
      // path above.
      await this.evictAllSeats(circleId);
      return null;
    }

    // 座位变更后的在线房间对齐(尽力而为;掉线成员重连时按座位重新派生)。
    //
    // 入房必须**先于** joined 事件完成。反过来的话:客户端收到 joined 立刻拉一次
    // 历史,而 joinUserToConversation 内部还在 await fetchSockets —— 这中间落库并
    // 广播的消息,历史拉取够不着(它还没写完?不,是拉取已经返回了),房间订阅也还
    // 没建立,于是那几条消息对这位新成员凭空消失,直到下次重连才补上。
    await Promise.all(
      result.toJoin.map(async (userID) => {
        try {
          await this.broadcast.joinUserToConversation(
            userID,
            result.conversationId,
          );
        } catch (error: unknown) {
          attemptDiagnostic(() =>
            this.logger.warn(
              sanitizeLogValue({
                event: 'chat_circle_sync_failed',
                operation: 'join_room',
                userId: userID,
                error,
              }),
            ),
          );
        }
        // 个人事件:会话即刻出现在本人列表里,不必等下一次全量拉取。
        this.broadcast.emitConversationChange(userID, {
          kind: 'joined',
          conversationId: result.conversationId,
          userId: userID,
        });
      }),
    );
    // 进/退群系统提示:初始建会话是存量播种,不逐人刷屏;之后的增量变化才提示。
    if (!result.created) {
      void this.emitMembershipNotices(
        result.conversationId,
        result.toJoin,
        result.toRemove,
      );
    }
    for (const userID of result.toRemove) {
      void this.broadcast
        .removeUserFromConversation(userID, result.conversationId)
        .catch((error: unknown) =>
          attemptDiagnostic(() =>
            this.logger.warn(
              sanitizeLogValue({
                event: 'chat_circle_sync_failed',
                operation: 'leave_room',
                userId: userID,
                error,
              }),
            ),
          ),
        );
      // 对账分不清主动退出还是被移出,统一 removed(UI 行为一致:收走会话)。
      this.broadcast.emitConversationChange(userID, {
        kind: 'removed',
        conversationId: result.conversationId,
        userId: userID,
      });
    }
    return result.conversationId;
  }

  /**
   * 成员行被**物理删除**时的座位回收,必须在删除所在的同一事务里调用。
   *
   * 为什么这一类变更不能交给对账:对账扫的是 `CircleMember.updatedAt` 窗口,
   * 而 DELETE 把整行抹掉 —— 扫描永远看不见它。踢人/退圈走的都是 delete,
   * 于是被移除的人座位一直是 leftAt=null,照样能读能发、还继续收群消息。
   * 这是对账机制结构上唯一覆盖不到的写法,所以只给 delete 埋钩子,增改仍旧
   * 交给对账(不破坏「不在 7 处写点逐一埋钩」的原设计)。
   *
   * 也不能挪到事务外做尽力而为:那样一次失败就再没有任何机制会回来收座位。
   *
   * 返回被回收座位所在的会话 id(本来就没在座则返回 null),调用方在事务提交后
   * 用它调 {@link detachSeat} 把在线 socket 踢出房间。
   */
  async releaseSeatInTx(
    tx: Prisma.TransactionClient,
    circleId: string,
    userId: string,
  ): Promise<string | null> {
    const conversation = await tx.chatConversation.findUnique({
      where: { circleID: circleId },
      select: { id: true },
    });
    if (!conversation) return null;
    const released = await tx.chatMember.updateMany({
      where: {
        conversationID: conversation.id,
        userID: userId,
        leftAt: null,
      },
      data: { leftAt: new Date() },
    });
    return released.count > 0 ? conversation.id : null;
  }

  /**
   * 事务提交后:把 socket 踢出会话房,并补一条「有成员退出群聊」的系统提示。
   *
   * 提示必须在这里发。对账里的 toRemove 只挑「座位仍是 leftAt=null 却已不在
   * ACTIVE 名单」的人,而 releaseSeatInTx 在事务里就把 leftAt 置好了 ——
   * 等对账跑到时它已经不满足条件;何况 CircleMember 行本身已被删除,对账的
   * updatedAt 窗口根本扫不到这个圈子。结果就是:真实的退群/踢人一条提示都没有,
   * 只有对账自己发现的差异才会提示,而那条路径实际上永远走不到。
   *
   * 提示是尽力而为(座位状态已经落库,丢了只是少一行灰字);**离房不是**。
   * 返回的 Promise 在离房尝试结束后 resolve,调用方应当 await 它。
   */
  async detachSeat(
    userId: string,
    conversationId: string,
    kind: 'left' | 'removed',
    emitMemberLeftNotice = true,
  ): Promise<void> {
    // 先离房,再发个人事件。
    //
    // 先派发清理再通知本人的 UI，减少旧会话房收敛窗口。跨节点 RemoteSocket
    // 清理没有 adapter ack，因此这只是 best-effort；chat:msg 的隐私边界是
    // 广播时重新查询 active ChatMember 并投个人房，不依赖这里完成。
    try {
      await this.broadcast.removeUserFromConversation(userId, conversationId);
    } catch (error: unknown) {
      attemptDiagnostic(() =>
        this.logger.warn(
          sanitizeLogValue({
            event: 'chat_circle_sync_failed',
            operation: 'detach_seat',
            userId,
            conversationId,
            error,
          }),
        ),
      );
      // 离不了房就断连接:重连时 handleConnection 会按当前座位重新派生房间,
      // 而他已经没有这个会话的座位了。
      try {
        await this.broadcast.disconnectUserSockets(userId);
      } catch (disconnectError: unknown) {
        attemptDiagnostic(() =>
          this.logger.error(
            sanitizeLogValue({
              event: 'chat_circle_sync_failed',
              operation: 'evict_sockets',
              userId,
              error: disconnectError,
            }),
          ),
        );
      }
    }
    // 个人事件:UI 收走会话靠它。left 与 removed 的区别只在客户端文案。
    this.broadcast.emitConversationChange(userId, {
      kind,
      conversationId,
      userId,
    });
    if (emitMemberLeftNotice) {
      // 群日志:主动退出记本人;被移出的那条由 GroupService 在事务里记(带操作者)。
      void this.groupEvents.record(conversationId, {
        kind: 'member-left',
        actorId: userId,
        targetIds: [userId],
      });
      void this.systemMessage
        .emit(conversationId, { kind: 'member-left' })
        .catch((error: unknown) =>
          attemptDiagnostic(() =>
            this.logger.warn(
              sanitizeLogValue({
                event: 'chat_circle_sync_failed',
                operation: 'member_left_notice',
                conversationId,
                error,
              }),
            ),
          ),
        );
    }
    // Manager removal can continue even if both cleanup dispatches failed:
    // its detailed log explicitly excludes the target and all chat:msg
    // delivery is independently filtered by the authoritative active seats.
  }

  /**
   * 圈子被解散/停用时收回全部在座座位,并把在线 socket 踢出会话房。
   * 幂等:座位已经清干净就什么都不做,不重复广播。
   */
  private async evictAllSeats(circleId: string): Promise<void> {
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { circleID: circleId },
      select: { id: true },
    });
    if (!conversation) return;
    const seated = await this.prisma.chatMember.findMany({
      where: { conversationID: conversation.id, leftAt: null },
      select: { userID: true },
    });
    if (seated.length === 0) return;
    await this.prisma.chatMember.updateMany({
      where: { conversationID: conversation.id, leftAt: null },
      data: { leftAt: new Date() },
    });
    for (const { userID } of seated) {
      void this.broadcast
        .removeUserFromConversation(userID, conversation.id)
        .catch((error: unknown) =>
          attemptDiagnostic(() =>
            this.logger.warn(
              sanitizeLogValue({
                event: 'chat_circle_sync_failed',
                operation: 'evict_room',
                userId: userID,
                error,
              }),
            ),
          ),
        );
      this.broadcast.emitConversationChange(userID, {
        kind: 'removed',
        conversationId: conversation.id,
        userId: userID,
      });
    }
  }

  /** 结构化系统提示:本地化留给前端 im.notification.* 词表。 */
  private async emitMembershipNotices(
    conversationId: string,
    joined: string[],
    removed: string[],
  ): Promise<void> {
    try {
      if (joined.length > 0) {
        // 对账入座没有邀请人:群日志的操作者留空(客户端显示「加入群聊」)。
        await this.groupEvents.record(conversationId, {
          kind: 'member-joined',
          actorId: null,
          targetIds: joined,
        });
        const users = await this.prisma.user.findMany({
          where: { id: { in: joined } },
          select: { nickname: true },
        });
        const names = users.map((u) => u.nickname).filter(Boolean);
        if (names.length > 0) {
          await this.systemMessage.emit(conversationId, {
            kind: 'member-joined',
            names,
          });
        }
      }
      if (removed.length > 0) {
        await this.groupEvents.record(conversationId, {
          kind: 'member-left',
          actorId: null,
          targetIds: removed,
        });
      }
      // 对账器分不清退出还是被移出,统一「有成员退出群聊」措辞。
      for (let i = 0; i < removed.length; i += 1) {
        await this.systemMessage.emit(conversationId, { kind: 'member-left' });
      }
    } catch (error) {
      attemptDiagnostic(() =>
        this.logger.warn(
          sanitizeLogValue({
            event: 'chat_circle_sync_failed',
            operation: 'membership_notice',
            conversationId,
            error,
          }),
        ),
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
