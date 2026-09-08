import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import type { ChatMember, Prisma } from 'src/generated/prisma';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatGroupEventService } from './chat-group-event.service';
import {
  canManageGroupTarget,
  circleGroupRole,
  type GroupRole,
  isGroupManager,
  isSeatSilenced,
  isValidSilenceDuration,
  silencedUntilOf,
  standaloneGroupRole,
} from './chat-group-roles';
import { ChatSystemMessageService } from './chat-system-message.service';
import type { ChatMemberSilenceDto, ChatMessageDto } from './chat.types';
import type { GroupMemberRoleInput } from './dto/group-admin.dto';

interface LockedGroupRow {
  id: string;
  type: string;
  circleID: string | null;
  ownerID: string | null;
  nextHeight: number;
}

interface ResolvedPair {
  actorRole: GroupRole | null;
  targetRole: GroupRole | null;
  targetSeat: ChatMember | null;
}

/**
 * 群管理:设/撤管理员、移出成员(独立群聊),逐人禁言/解除(两种群)。
 *
 * 圈子群的设角色/移出仍走 GroupService(它还要动 CircleMember、邀请、图标),
 * 这里对圈子群只提供禁言 —— 禁言状态在座位(ChatMember)上,两种群共用一张表。
 *
 * 锁序与 ChatService 的退群/清空一致:**先鉴权(锁外快照)再取会话行锁**,锁后用
 * 锁后快照重做一遍授权。锁外那次不是多余的:它挡住非管理员让服务端为任意目标
 * 上锁、拿错误差异探测「此人在不在群里」。
 */
@Injectable()
export class ChatGroupAdminService {
  private readonly logger = new Logger(ChatGroupAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly systemMessage: ChatSystemMessageService,
    private readonly groupEvents: ChatGroupEventService,
  ) {}

  /** 独立群聊:群主设/撤管理员。幂等:已是目标角色时不写提示、不记事件。 */
  async setStandaloneMemberRole(
    actorId: string,
    conversationId: string,
    targetUserId: string,
    role: GroupMemberRoleInput,
  ): Promise<{ userId: string; role: GroupMemberRoleInput }> {
    this.assertNotSelf(actorId, targetUserId);
    const preflight = await this.preflightStandalone(conversationId, actorId);
    if (preflight.actorRole !== 'OWNER') {
      throw new ForbiddenException({
        message: '仅群主可设置管理员',
        errorCode: ChatErrorCode.GroupOwnerOnly,
      });
    }

    const notice = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      this.assertStandalone(locked);
      const { actorRole, targetRole, targetSeat } = await this.resolvePair(
        tx,
        locked,
        actorId,
        targetUserId,
      );
      if (actorRole !== 'OWNER') {
        throw new ForbiddenException({
          message: '仅群主可设置管理员',
          errorCode: ChatErrorCode.GroupOwnerOnly,
        });
      }
      const seat = this.requireTargetSeat(targetSeat, targetRole);
      if (targetRole === 'OWNER') {
        throw new ForbiddenException({
          message: '不能修改群主的角色',
          errorCode: ChatErrorCode.GroupTargetProtected,
        });
      }
      if (seat.role === role) return null;
      await tx.chatMember.update({
        where: { id: seat.id },
        data: { role },
      });
      const message =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          { kind: 'member-role-changed', actorId, targetUserId, role },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'member-role-changed',
        actorId,
        targetIds: [targetUserId],
        payload: { role },
      });
      return message;
    });

    if (notice) {
      await this.broadcastAfterCommit(notice);
      // 目标的会话 DTO 没变,但 ChatInfo 的角色徽标/管理入口要刷新:
      // 个人房 updated 事件让客户端重拉。
      this.broadcast.emitConversationChange(targetUserId, {
        kind: 'updated',
        conversationId,
        userId: targetUserId,
      });
    }
    return { userId: targetUserId, role };
  }

  /** 独立群聊:群主/管理员移出成员(管理员只能移普通成员)。 */
  async removeStandaloneMember(
    actorId: string,
    conversationId: string,
    targetUserId: string,
  ): Promise<void> {
    if (actorId === targetUserId) {
      throw new ForbiddenException({
        message: '退出群聊请用退群端点',
        errorCode: ChatErrorCode.GroupSelfTarget,
      });
    }
    const preflight = await this.preflightStandalone(conversationId, actorId);
    this.assertManager(preflight.actorRole);

    const notice = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      this.assertStandalone(locked);
      const { actorRole, targetRole, targetSeat } = await this.resolvePair(
        tx,
        locked,
        actorId,
        targetUserId,
      );
      this.assertManager(actorRole);
      const seat = this.requireTargetSeat(targetSeat, targetRole);
      this.assertCanManage(actorRole, targetRole);
      // 座位关闭时复位管理员标记(再被拉回来是普通成员);禁言**不**复位,
      // 否则被踢再扫码回来等于自助解禁。
      await tx.chatMember.update({
        where: { id: seat.id },
        data: { leftAt: new Date(), role: 'MEMBER' },
      });
      const message =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          { kind: 'member-removed', actorId, targetUserId },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'member-removed',
        actorId,
        targetIds: [targetUserId],
      });
      return message;
    });

    // 先离房、再通知本人 UI、最后把提示播给其余成员(被移出的人不收)。
    // 与圈子群踢人(ChatCircleSyncService.detachSeat)同一顺序。
    try {
      await this.broadcast.removeUserFromConversation(
        targetUserId,
        conversationId,
      );
    } catch (error) {
      this.logger.warn(
        `remove member room detach failed conversation=${conversationId} (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
    this.broadcast.emitConversationChange(targetUserId, {
      kind: 'removed',
      conversationId,
      userId: targetUserId,
    });
    try {
      await this.systemMessage.broadcastSystemMessageExcludingUsers(notice, [
        targetUserId,
      ]);
    } catch (error) {
      this.logger.warn(
        `remove member realtime delivery failed after commit (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
  }

  /** 禁言(两种群):durationSec = null 表示直到解除。重复禁言 = 覆盖时长。 */
  async silenceMember(
    actorId: string,
    conversationId: string,
    targetUserId: string,
    durationSec: number | null,
  ): Promise<ChatMemberSilenceDto> {
    this.assertNotSelf(actorId, targetUserId);
    if (!isValidSilenceDuration(durationSec)) {
      throw new BadRequestException({
        message: '禁言时长无效',
        errorCode: ChatErrorCode.SilenceDurationInvalid,
      });
    }
    const preflight = await this.preflightGroup(conversationId, actorId);
    this.assertManager(preflight.actorRole);

    const { notice, seat } = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      const { actorRole, targetRole, targetSeat } = await this.resolvePair(
        tx,
        locked,
        actorId,
        targetUserId,
      );
      this.assertManager(actorRole);
      const current = this.requireTargetSeat(targetSeat, targetRole);
      this.assertCanManage(actorRole, targetRole);
      const now = new Date();
      const updated = await tx.chatMember.update({
        where: { id: current.id },
        data: {
          silencedAt: now,
          silencedUntil:
            durationSec === null
              ? null
              : new Date(now.getTime() + durationSec * 1000),
        },
      });
      const message =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          { kind: 'member-silenced', actorId, targetUserId, durationSec },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'member-silenced',
        actorId,
        targetIds: [targetUserId],
        payload: { durationSec },
      });
      return { notice: message, seat: updated };
    });

    await this.broadcastAfterCommit(notice);
    // 被禁言的人要立刻看到输入区横幅:个人房 updated 让客户端重拉会话 DTO。
    this.broadcast.emitConversationChange(targetUserId, {
      kind: 'updated',
      conversationId,
      userId: targetUserId,
    });
    return this.toSilenceDto(targetUserId, seat);
  }

  /** 解除禁言(两种群)。目标本就未禁言时幂等返回,不写提示、不记事件。 */
  async unsilenceMember(
    actorId: string,
    conversationId: string,
    targetUserId: string,
  ): Promise<ChatMemberSilenceDto> {
    this.assertNotSelf(actorId, targetUserId);
    const preflight = await this.preflightGroup(conversationId, actorId);
    this.assertManager(preflight.actorRole);

    const { notice, seat } = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      const { actorRole, targetRole, targetSeat } = await this.resolvePair(
        tx,
        locked,
        actorId,
        targetUserId,
      );
      this.assertManager(actorRole);
      const current = this.requireTargetSeat(targetSeat, targetRole);
      this.assertCanManage(actorRole, targetRole);
      if (!isSeatSilenced(current)) {
        return { notice: null, seat: current };
      }
      const updated = await tx.chatMember.update({
        where: { id: current.id },
        data: { silencedAt: null, silencedUntil: null },
      });
      const message =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          { kind: 'member-unsilenced', actorId, targetUserId },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'member-unsilenced',
        actorId,
        targetIds: [targetUserId],
      });
      return { notice: message, seat: updated };
    });

    if (notice) {
      await this.broadcastAfterCommit(notice);
      this.broadcast.emitConversationChange(targetUserId, {
        kind: 'updated',
        conversationId,
        userId: targetUserId,
      });
    }
    return this.toSilenceDto(targetUserId, seat);
  }

  // ── 共同的门 ────────────────────────────────────────────────────────────

  private assertNotSelf(actorId: string, targetUserId: string): void {
    if (actorId === targetUserId) {
      throw new ForbiddenException({
        message: '不能对自己执行此操作',
        errorCode: ChatErrorCode.GroupSelfTarget,
      });
    }
  }

  private assertManager(role: GroupRole | null): void {
    if (!isGroupManager(role)) {
      throw new ForbiddenException({
        message: '仅群主或管理员可操作',
        errorCode: ChatErrorCode.GroupManagerOnly,
      });
    }
  }

  private assertCanManage(
    actorRole: GroupRole | null,
    targetRole: GroupRole | null,
  ): void {
    if (!canManageGroupTarget(actorRole, targetRole)) {
      throw new ForbiddenException({
        message: '不能对群主或同级管理员执行此操作',
        errorCode: ChatErrorCode.GroupTargetProtected,
      });
    }
  }

  private requireTargetSeat(
    seat: ChatMember | null,
    role: GroupRole | null,
  ): ChatMember {
    // 圈子群里座位可能落后于 CircleMember(对账窗口):没座位就没有可写的
    // 禁言状态,一并按「不在群里」处理。
    if (!seat || seat.leftAt || role === null) {
      throw new NotFoundException({
        message: '对方不在群里',
        errorCode: ChatErrorCode.GroupMemberNotFound,
      });
    }
    return seat;
  }

  private assertStandalone(row: {
    type: string;
    circleID: string | null;
  }): void {
    if (row.type !== 'GROUP') {
      throw new NotFoundException({
        message: '群聊不存在',
        errorCode: ChatErrorCode.ConversationNotFound,
      });
    }
    if (row.circleID) {
      throw new ForbiddenException({
        message: '该群由圈子管理',
        errorCode: ChatErrorCode.GroupCircleManaged,
      });
    }
  }

  /** 锁外快照:本人在座 + 是 GROUP;返回本人角色(独立群/圈子群各自算)。 */
  private async preflightGroup(
    conversationId: string,
    actorId: string,
  ): Promise<{ circleID: string | null; actorRole: GroupRole | null }> {
    const seat = await this.prisma.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: actorId,
        },
      },
      include: { conversation: true },
    });
    if (!seat || seat.leftAt) {
      throw new ForbiddenException({
        message: '不是会话成员',
        errorCode: ChatErrorCode.NotMember,
      });
    }
    if (seat.conversation.type !== 'GROUP') {
      throw new NotFoundException({
        message: '群聊不存在',
        errorCode: ChatErrorCode.ConversationNotFound,
      });
    }
    const circleID = seat.conversation.circleID;
    if (!circleID) {
      return {
        circleID,
        actorRole: standaloneGroupRole(seat.conversation.ownerID, seat),
      };
    }
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: actorId, circleID } },
      select: { role: true, status: true },
    });
    return { circleID, actorRole: circleGroupRole(membership) };
  }

  private async preflightStandalone(
    conversationId: string,
    actorId: string,
  ): Promise<{ actorRole: GroupRole | null }> {
    const result = await this.preflightGroup(conversationId, actorId);
    if (result.circleID) {
      throw new ForbiddenException({
        message: '该群由圈子管理',
        errorCode: ChatErrorCode.GroupCircleManaged,
      });
    }
    return result;
  }

  private async lockGroup(
    tx: Prisma.TransactionClient,
    conversationId: string,
  ): Promise<LockedGroupRow> {
    const locked = await tx.$queryRaw<LockedGroupRow[]>`
      SELECT "id", "type", "circleID", "ownerID", "nextHeight"
      FROM "ChatConversation"
      WHERE "id" = ${conversationId} FOR UPDATE`;
    if (locked.length === 0 || locked[0].type !== 'GROUP') {
      throw new NotFoundException({
        message: '群聊不存在',
        errorCode: ChatErrorCode.ConversationNotFound,
      });
    }
    return locked[0];
  }

  /**
   * 锁后快照里的双方角色。圈子群读 CircleMember(会话锁已持有:GroupService 的
   * 角色变更/移除都先拿会话锁再动 CircleMember,不会与这里交错);独立群读座位。
   */
  private async resolvePair(
    tx: Prisma.TransactionClient,
    locked: LockedGroupRow,
    actorId: string,
    targetUserId: string,
  ): Promise<ResolvedPair> {
    const seats = await tx.chatMember.findMany({
      where: {
        conversationID: locked.id,
        userID: { in: [actorId, targetUserId] },
      },
    });
    const actorSeat = seats.find((seat) => seat.userID === actorId) ?? null;
    const targetSeat =
      seats.find((seat) => seat.userID === targetUserId) ?? null;
    if (!locked.circleID) {
      return {
        actorRole: standaloneGroupRole(locked.ownerID, actorSeat),
        targetRole: standaloneGroupRole(locked.ownerID, targetSeat),
        targetSeat,
      };
    }
    const memberships = await tx.circleMember.findMany({
      where: {
        circleID: locked.circleID,
        userID: { in: [actorId, targetUserId] },
      },
      select: { userID: true, role: true, status: true },
    });
    const roleOf = (userId: string): GroupRole | null =>
      circleGroupRole(memberships.find((row) => row.userID === userId));
    return {
      actorRole: actorSeat && !actorSeat.leftAt ? roleOf(actorId) : null,
      targetRole: roleOf(targetUserId),
      targetSeat,
    };
  }

  private async broadcastAfterCommit(notice: ChatMessageDto): Promise<void> {
    try {
      await this.systemMessage.broadcastSystemMessage(notice);
    } catch (error) {
      // 变更与事件已提交;实时投递只做 best-effort,且不记录可能含用户标识的正文。
      this.logger.warn(
        `group admin realtime delivery failed after commit (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
  }

  private toSilenceDto(userId: string, seat: ChatMember): ChatMemberSilenceDto {
    return {
      userId,
      silenced: isSeatSilenced(seat),
      silencedUntil: silencedUntilOf(seat),
    };
  }
}
