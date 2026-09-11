import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import type { ChatMember, Prisma } from 'src/generated/prisma';
import {
  isUrlFromStorage,
  storagePublicObjectBasesFromConfig,
} from 'src/utils/storage-url';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatGroupEventService } from './chat-group-event.service';
import {
  circleGroupRole,
  type GroupRole,
  isGroupManager,
  standaloneGroupRole,
} from './chat-group-roles';
import { ChatSystemMessageService } from './chat-system-message.service';
import type { ChatGroupPoliciesDto, ChatMessageDto } from './chat.types';

/** 锁后的会话行:群策略与全员禁言都从这份快照读、往这行写。 */
interface LockedGroupRow {
  id: string;
  type: string;
  circleID: string | null;
  ownerID: string | null;
  nextHeight: number;
  muteAllAt: Date | null;
  notice: string | null;
  avatarUrl: string | null;
  memberCanInvite: boolean;
  qrJoinEnabled: boolean;
  membersCanViewRoster: boolean;
  membersCanViewProfiles: boolean;
  membersCanAddFriends: boolean;
}

/** PATCH /policies 可改的键;圈子群的 memberCanInvite 写在 Circle 上。 */
export type GroupPolicyKey = keyof ChatGroupPoliciesDto;
const POLICY_KEYS: readonly GroupPolicyKey[] = [
  'memberCanInvite',
  'qrJoinEnabled',
  'membersCanViewRoster',
  'membersCanViewProfiles',
  'membersCanAddFriends',
];

/**
 * 群设置(第二批):全员禁言开关、群主转让、独立群公告/头像、群策略开关。
 *
 * 与 ChatGroupAdminService 同一套锁序:先用锁外快照鉴权(非管理员碰不到会话行锁),
 * 锁后再用锁后快照重做一遍;变更、系统提示、群日志同事务,广播在提交之后。
 * 全员禁言与四个策略两种群都开放;转让/公告/头像只有独立群(圈子群的这些在圈子上)。
 */
@Injectable()
export class ChatGroupSettingsService {
  private readonly logger = new Logger(ChatGroupSettingsService.name);
  private readonly storagePublicObjectBases: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly broadcast: ChatBroadcastService,
    private readonly systemMessage: ChatSystemMessageService,
    private readonly groupEvents: ChatGroupEventService,
  ) {
    this.storagePublicObjectBases = storagePublicObjectBasesFromConfig(
      this.config,
    );
  }

  /** 全员禁言开关(两种群;群主/管理员)。已是目标状态时幂等,不写提示、不记事件。 */
  async setMuteAll(
    actorId: string,
    conversationId: string,
    enabled: boolean,
  ): Promise<{ muteAll: boolean }> {
    const preflight = await this.preflightGroup(conversationId, actorId);
    this.assertManager(preflight.actorRole);

    const notice = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      this.assertManager(await this.actorRoleInTx(tx, locked, actorId));
      if ((locked.muteAllAt !== null) === enabled) return null;
      await tx.chatConversation.update({
        where: { id: locked.id },
        data: { muteAllAt: enabled ? new Date() : null },
      });
      const message =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          { kind: 'mute-all-changed', actorId, enabled },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'mute-all-changed',
        actorId,
        payload: { enabled },
      });
      return message;
    });
    // 全员都要立刻知道:系统提示本身就播给整个会话房,客户端收到这条提示时
    // 顺手把会话的 muteAll 翻过来,不再逐人推 N 条个人房 updated。
    if (notice) await this.broadcastAfterCommit(notice);
    return { muteAll: enabled };
  }

  /**
   * 独立群聊:群主转让(圈子群的圈主转让牵涉会员配额与容量,不在这里)。
   * 新群主的座位管理员标记与禁言一并清零(群主不能对自己解禁);原群主降为普通成员。
   */
  async transferOwnership(
    actorId: string,
    conversationId: string,
    targetUserId: string,
  ): Promise<void> {
    if (actorId === targetUserId) {
      throw new ForbiddenException({
        message: '不能转让给自己',
        errorCode: ChatErrorCode.GroupSelfTarget,
      });
    }
    const preflight = await this.preflightStandalone(conversationId, actorId);
    this.assertOwner(preflight.actorRole);

    const notice = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      this.assertStandalone(locked);
      if (locked.ownerID !== actorId) {
        throw new ForbiddenException({
          message: '仅群主可转让群聊',
          errorCode: ChatErrorCode.GroupOwnerOnly,
        });
      }
      const seats = await tx.chatMember.findMany({
        where: {
          conversationID: locked.id,
          userID: { in: [actorId, targetUserId] },
        },
      });
      const targetSeat = seats.find((seat) => seat.userID === targetUserId);
      const actorSeat = seats.find((seat) => seat.userID === actorId);
      if (!targetSeat || targetSeat.leftAt) {
        throw new NotFoundException({
          message: '对方不在群里',
          errorCode: ChatErrorCode.GroupMemberNotFound,
        });
      }
      // 转让是**单向不可撤销**的:交出去之后原群主就是普通成员,再也拿不回来。
      // 所以目标必须是一个真的能管群的人 —— 封禁/注销的账号接手等于这个群
      // 从此无人可管;互相拉黑的两个人之间也不该有这种托付关系(对端在本人的
      // 界面里本来就不可见,多半是误点或被诱导)。
      const target = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { nickname: true, status: true },
      });
      if (!target || target.status !== 'ACTIVE') {
        throw new NotFoundException({
          message: '对方不存在或不可用',
          errorCode: ChatErrorCode.PeerNotFound,
        });
      }
      const block = await tx.block.findFirst({
        where: {
          OR: [
            { blockerID: actorId, blockedID: targetUserId },
            { blockerID: targetUserId, blockedID: actorId },
          ],
        },
        select: { id: true },
      });
      if (block) {
        throw new ForbiddenException({
          message: '对方不可用',
          errorCode: ChatErrorCode.Blocked,
        });
      }
      await tx.chatConversation.update({
        where: { id: locked.id },
        data: { ownerID: targetUserId },
      });
      await tx.chatMember.update({
        where: { id: targetSeat.id },
        data: { role: 'MEMBER', silencedAt: null, silencedUntil: null },
      });
      if (actorSeat) {
        await tx.chatMember.update({
          where: { id: actorSeat.id },
          data: { role: 'MEMBER' },
        });
      }
      const message =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          {
            kind: 'owner-transferred',
            actorId,
            targetUserId,
            ...(target.nickname ? { name: target.nickname } : {}),
          },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'owner-transferred',
        actorId,
        targetIds: [targetUserId],
      });
      return message;
    });

    await this.broadcastAfterCommit(notice);
    // 双方的会话 DTO(myRole / ownerId)都变了:各推一条 updated 让客户端重拉。
    for (const userId of [targetUserId, actorId]) {
      this.broadcast.emitConversationChange(userId, {
        kind: 'updated',
        conversationId,
        userId,
      });
    }
  }

  /** 独立群聊公告(群主/管理员;空串 = 清空)。未变化时幂等。 */
  async setNotice(
    actorId: string,
    conversationId: string,
    notice: string,
  ): Promise<{ notice: string | null }> {
    const trimmed = notice.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    const preflight = await this.preflightStandalone(conversationId, actorId);
    this.assertManager(preflight.actorRole);

    const message = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      this.assertStandalone(locked);
      this.assertManager(await this.actorRoleInTx(tx, locked, actorId));
      if ((locked.notice ?? null) === next) return null;
      await tx.chatConversation.update({
        where: { id: locked.id },
        data: { notice: next },
      });
      const inserted =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          { kind: 'group-notice-updated', actorId },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'group-notice-updated',
        actorId,
      });
      return inserted;
    });
    if (message) await this.broadcastAfterCommit(message);
    return { notice: next };
  }

  /**
   * 独立群聊头像(群主/管理员);URL 必须来自本应用存储,与圈子头像同一条线。
   * 与 setNotice/setMuteAll 一样未变化时幂等 —— 上传重试拿到同一个 key 时
   * 再插一条「群头像已更新」提示与一条群日志,就是凭空复制治理记录。
   */
  async setAvatar(
    actorId: string,
    conversationId: string,
    avatarUrl: string,
  ): Promise<{ avatarUrl: string }> {
    const trimmed = avatarUrl.trim();
    if (
      trimmed.length === 0 ||
      (this.storagePublicObjectBases.length > 0 &&
        !isUrlFromStorage(trimmed, this.storagePublicObjectBases))
    ) {
      throw new BadRequestException({
        message: '群头像必须来自本应用的存储',
        errorCode: ChatErrorCode.GroupAvatarUrlInvalid,
      });
    }
    const preflight = await this.preflightStandalone(conversationId, actorId);
    this.assertManager(preflight.actorRole);

    const message = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      this.assertStandalone(locked);
      this.assertManager(await this.actorRoleInTx(tx, locked, actorId));
      if ((locked.avatarUrl ?? null) === trimmed) return null;
      await tx.chatConversation.update({
        where: { id: locked.id },
        data: { avatarUrl: trimmed },
      });
      const inserted =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          locked.id,
          locked.nextHeight,
          { kind: 'group-avatar-updated', actorId },
        );
      await this.groupEvents.recordInTx(tx, locked.id, {
        kind: 'group-avatar-updated',
        actorId,
      });
      return inserted;
    });
    if (message) await this.broadcastAfterCommit(message);
    return { avatarUrl: trimmed };
  }

  /**
   * 群策略开关(两种群;群主/管理员)。只写真正变化的键,每个变化一条提示 + 一条日志;
   * 圈子群的 memberCanInvite 是 Circle 的字段,写到那边(邀请闸门读的就是它)。
   */
  async updatePolicies(
    actorId: string,
    conversationId: string,
    patch: Partial<ChatGroupPoliciesDto>,
  ): Promise<ChatGroupPoliciesDto> {
    const preflight = await this.preflightGroup(conversationId, actorId);
    this.assertManager(preflight.actorRole);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockGroup(tx, conversationId);
      this.assertManager(await this.actorRoleInTx(tx, locked, actorId));
      const current = await this.policiesOf(tx, locked);
      const changes = POLICY_KEYS.filter(
        (key) => patch[key] !== undefined && patch[key] !== current[key],
      );
      const messages: ChatMessageDto[] = [];
      let nextHeight = locked.nextHeight;
      for (const key of changes) {
        const enabled = patch[key] as boolean;
        if (key === 'memberCanInvite' && locked.circleID) {
          await tx.circle.update({
            where: { id: locked.circleID },
            data: { memberCanInvite: enabled },
          });
        } else {
          await tx.chatConversation.update({
            where: { id: locked.id },
            data: { [key]: enabled },
          });
        }
        const message =
          await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
            tx,
            locked.id,
            nextHeight,
            { kind: 'group-policy-changed', actorId, policy: key, enabled },
          );
        nextHeight = message.height;
        messages.push(message);
        await this.groupEvents.recordInTx(tx, locked.id, {
          kind: 'policy-changed',
          actorId,
          payload: { policy: key, enabled },
        });
      }
      const next: ChatGroupPoliciesDto = { ...current };
      for (const key of changes) next[key] = patch[key] as boolean;
      return { messages, policies: next };
    });

    for (const message of result.messages) {
      await this.broadcastAfterCommit(message);
    }
    return result.policies;
  }

  // ── 共同的门 ────────────────────────────────────────────────────────────

  private assertManager(role: GroupRole | null): void {
    if (!isGroupManager(role)) {
      throw new ForbiddenException({
        message: '仅群主或管理员可操作',
        errorCode: ChatErrorCode.GroupManagerOnly,
      });
    }
  }

  private assertOwner(role: GroupRole | null): void {
    if (role !== 'OWNER') {
      throw new ForbiddenException({
        message: '仅群主可操作',
        errorCode: ChatErrorCode.GroupOwnerOnly,
      });
    }
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
      SELECT "id", "type", "circleID", "ownerID", "nextHeight", "muteAllAt", "notice",
             "avatarUrl", "memberCanInvite", "qrJoinEnabled", "membersCanViewRoster",
             "membersCanViewProfiles", "membersCanAddFriends"
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

  /** 锁后快照里本人的角色(与 ChatGroupAdminService.resolvePair 同一口径)。 */
  private async actorRoleInTx(
    tx: Prisma.TransactionClient,
    locked: LockedGroupRow,
    actorId: string,
  ): Promise<GroupRole | null> {
    const seat: ChatMember | null = await tx.chatMember.findUnique({
      where: {
        conversationID_userID: { conversationID: locked.id, userID: actorId },
      },
    });
    if (!seat || seat.leftAt) return null;
    if (!locked.circleID) return standaloneGroupRole(locked.ownerID, seat);
    const membership = await tx.circleMember.findUnique({
      where: {
        userID_circleID: { userID: actorId, circleID: locked.circleID },
      },
      select: { role: true, status: true },
    });
    return circleGroupRole(membership);
  }

  private async policiesOf(
    tx: Prisma.TransactionClient,
    locked: LockedGroupRow,
  ): Promise<ChatGroupPoliciesDto> {
    let memberCanInvite = locked.memberCanInvite;
    if (locked.circleID) {
      const circle = await tx.circle.findUnique({
        where: { id: locked.circleID },
        select: { memberCanInvite: true },
      });
      memberCanInvite = circle?.memberCanInvite ?? true;
    }
    return {
      memberCanInvite,
      qrJoinEnabled: locked.qrJoinEnabled,
      membersCanViewRoster: locked.membersCanViewRoster,
      membersCanViewProfiles: locked.membersCanViewProfiles,
      membersCanAddFriends: locked.membersCanAddFriends,
    };
  }

  private async broadcastAfterCommit(notice: ChatMessageDto): Promise<void> {
    try {
      await this.systemMessage.broadcastSystemMessage(notice);
    } catch (error) {
      // 变更与事件已提交;实时投递只做 best-effort,且不记录可能含用户标识的正文。
      this.logger.warn(
        `group settings realtime delivery failed after commit (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
  }
}
