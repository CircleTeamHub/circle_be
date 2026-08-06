import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatBroadcastService } from './chat-broadcast.service';

/**
 * 圈子成员 ←→ 群会话座位的同步(自研聊天版的 group-sync)。
 *
 * 机制:幂等 ensure + 定时对账,不在 7 处 CircleMember 写点逐一埋钩子 ——
 * 主动触发只有两个:建圈后(circle.service 尽力而为调用)与前端开圈聊时
 * (POST /chat/conversations/circle);其余变更由每分钟的对账兜底
 * (CircleMember.updatedAt 窗口扫描,与 like-reconciliation 同款模式)。
 * 代价:踢人/退圈的座位收回最迟延后一个对账周期(≤1min),测试期可接受。
 */
@Injectable()
export class ChatCircleSyncService {
  private readonly logger = new Logger(ChatCircleSyncService.name);

  /** 对账扫描窗口:2 个周期重叠,防止边界上的变更漏扫。 */
  private static readonly RECONCILE_WINDOW_MS = 2 * 60_000;
  private static readonly RECONCILE_BATCH = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileRecent(): Promise<void> {
    const since = new Date(
      Date.now() - ChatCircleSyncService.RECONCILE_WINDOW_MS,
    );
    let changed: Array<{ circleID: string }>;
    try {
      changed = await this.prisma.circleMember.findMany({
        where: { updatedAt: { gt: since } },
        select: { circleID: true },
        distinct: ['circleID'],
        take: ChatCircleSyncService.RECONCILE_BATCH,
      });
    } catch (error) {
      this.logger.error(
        `reconcile scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const { circleID } of changed) {
      try {
        await this.ensureCircleConversation(circleID);
      } catch (error) {
        // 单圈失败不拖垮整轮,下个周期窗口重叠会再试。
        this.logger.warn(
          `reconcile circle ${circleID} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * 幂等:确保圈子的 GROUP 会话存在,且座位与 CircleMember(ACTIVE) 对齐。
   * 返回 conversationId;圈子不存在返回 null。
   * 集合式写法(createMany skipDuplicates / 条件 updateMany),并发重入安全。
   */
  async ensureCircleConversation(circleId: string): Promise<string | null> {
    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { id: true },
    });
    if (!circle) return null;

    const result = await this.prisma.$transaction(async (tx) => {
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

      await tx.chatMember.createMany({
        data: activeIds
          .filter((id) => !seatByUser.has(id))
          .map((userID) => ({ conversationID: conversation.id, userID })),
        skipDuplicates: true,
      });
      await tx.chatMember.updateMany({
        where: {
          conversationID: conversation.id,
          userID: { in: activeIds },
          leftAt: { not: null },
        },
        data: { leftAt: null },
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

      return { conversationId: conversation.id, toJoin, toRemove };
    });

    // 座位变更后的在线房间对齐(尽力而为;掉线成员重连时按座位重新派生)。
    for (const userID of result.toJoin) {
      void this.broadcast
        .joinUserToConversation(userID, result.conversationId)
        .catch((error: unknown) =>
          this.logger.warn(
            `join room failed user=${userID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
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
    }
    return result.conversationId;
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
