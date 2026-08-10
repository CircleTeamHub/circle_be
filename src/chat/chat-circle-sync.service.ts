import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatSystemMessageService } from './chat-system-message.service';

/**
 * 不再持有群聊的管理态。DISABLING/RESTORING 也算在内:处理中的圈子
 * 默认拒绝(宁可晚一分钟恢复,也不要在停用窗口里把门开着)。
 */
/** 圈子座位对账的 advisory lock 命名空间(与 chat 的其它锁不撞)。 */
const CIRCLE_SYNC_LOCK_NAMESPACE = 7302;

const DISABLED_ADMIN_STATES = new Set<string>([
  'DISABLING',
  'DISABLED',
  'RESTORING',
  'SYNC_FAILED',
  'DISMISSED',
]);

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
  /** 单轮扫描上限,纯粹是失控查询的兜底(正常量级远低于此)。 */
  private static readonly RECONCILE_SCAN_MAX = 10_000;
  private static readonly RETRY_QUEUE_MAX = 1000;

  /**
   * 上轮失败、需要继续重试的圈子。进程内保存:重启会丢,但重启后任一成员
   * 变更都会把它重新带回扫描窗口,而窗口本身是从数据推导的(无需持久游标)。
   */
  private readonly retryQueue = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly systemMessage: ChatSystemMessageService,
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

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileRecent(): Promise<void> {
    const since = new Date(
      Date.now() - ChatCircleSyncService.RECONCILE_WINDOW_MS,
    );
    let changed: string[];
    try {
      changed = await this.scanChangedCircles(since);
    } catch (error) {
      this.logger.error(
        `reconcile scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // 上轮失败的圈子跟着重试:只靠窗口重叠的话,连续失败超过 2 分钟就永远
    // 掉出扫描范围,被踢成员的座位会一直留着(还能读能发)。
    const pending = [...this.retryQueue];
    this.retryQueue.clear();
    for (const circleID of new Set([...changed, ...pending])) {
      try {
        await this.ensureCircleConversation(circleID);
      } catch (error) {
        // 单圈失败不拖垮整轮;排进重试队列,直到成功为止。
        if (this.retryQueue.size < ChatCircleSyncService.RETRY_QUEUE_MAX) {
          this.retryQueue.add(circleID);
        }
        this.logger.warn(
          `reconcile circle ${circleID} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * 窗口内发生过成员变更的全部圈子(游标翻页跑完)。
   * 原来只取首批 200 且不翻页:一分钟内变更超过 200 个圈子时,多出来的
   * 会被静默丢掉且再也不会被选中 —— 那些圈子里被移除的成员会无限期保留座位。
   */
  private async scanChangedCircles(since: Date): Promise<string[]> {
    // 一次 SELECT DISTINCT 取回窗口内全部圈子 id(只有 UUID,量级很小),
    // 不再靠 take:200 截断 —— circleID 在 CircleMember 上不唯一,做不了游标翻页,
    // 而截断就意味着多出来的圈子这一轮直接消失。上限只是失控兜底。
    const rows = await this.prisma.$queryRaw<Array<{ circleID: string }>>`
      SELECT DISTINCT "circleID"
      FROM "CircleMember"
      WHERE "updatedAt" > ${since}
      LIMIT ${ChatCircleSyncService.RECONCILE_SCAN_MAX}
    `;
    if (rows.length >= ChatCircleSyncService.RECONCILE_SCAN_MAX) {
      // 触顶只可能是异常量级的写入洪峰:记一条,剩余部分下个周期继续。
      this.logger.warn(
        `reconcile scan hit the ${ChatCircleSyncService.RECONCILE_SCAN_MAX}-circle cap; remainder deferred to the next tick`,
      );
    }
    return rows.map((row) => row.circleID);
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
      let created = false;
      let conversation = await tx.chatConversation.findUnique({
        where: { circleID: circleId },
        select: { id: true },
      });
      if (!conversation) {
        try {
          conversation = await tx.chatConversation.create({
            data: { type: 'GROUP', circleID: circleId },
            select: { id: true },
          });
          created = true;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          conversation = await tx.chatConversation.findUnique({
            where: { circleID: circleId },
            select: { id: true },
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
          this.logger.warn(
            `join room failed user=${userID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
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
          this.logger.warn(
            `leave room failed user=${userID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
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
   * 两件事都是尽力而为:座位状态已经落库,提示丢了只是少一行灰字。
   */
  detachSeat(
    userId: string,
    conversationId: string,
    kind: 'left' | 'removed',
  ): void {
    // 个人事件先行:socket 离房只保证收不到新消息,UI 收走会话要靠这条。
    // left 与 removed 的区别只在客户端文案(被移出才提示),行为一致。
    this.broadcast.emitConversationChange(userId, {
      kind,
      conversationId,
      userId,
    });
    void this.broadcast
      .removeUserFromConversation(userId, conversationId)
      .catch((error: unknown) =>
        this.logger.warn(
          `detach seat failed user=${userId} conversation=${conversationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    void this.systemMessage
      .emit(conversationId, { kind: 'member-left' })
      .catch((error: unknown) =>
        this.logger.warn(
          `member-left notice failed conversation=${conversationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
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
          this.logger.warn(
            `evict room failed user=${userID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
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
      // 对账器分不清退出还是被移出,统一「有成员退出群聊」措辞。
      for (let i = 0; i < removed.length; i += 1) {
        await this.systemMessage.emit(conversationId, { kind: 'member-left' });
      }
    } catch (error) {
      this.logger.warn(
        `membership notice failed conversation=${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
