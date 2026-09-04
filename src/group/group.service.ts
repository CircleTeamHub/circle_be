import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CircleMemberRole,
  CircleMemberStatus,
  Prisma,
  ReportReviewStatus,
} from 'src/generated/prisma';
import { GroupErrorCode } from 'src/common/app-error-codes';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import type { ChatMessageDto } from 'src/chat/chat.types';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { normalizeUserIdAlias } from 'src/user/user-id-alias';
import { PrismaService } from 'src/prisma/prisma.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  GroupMemberRoleInput,
  GroupMemberRoleResultDto,
  InviteGroupMembersDto,
  UpdateGroupMemberRoleDto,
} from './dto/group-member.dto';
import { ReportGroupDto } from './dto/group-report.dto';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { reportOperationalError } from 'src/logging/error-aggregation.service';

type GroupMemberSyncResult = { handled: boolean };
type CircleGroupLookup = {
  id: string;
  groupID: string | null;
  ownerID: string;
  deleted: boolean;
};

type CircleGroupMemberLookup = {
  id: string;
  role: CircleMemberRole;
  status: CircleMemberStatus;
};

@Injectable()
export class GroupService {
  private readonly logger = new Logger(GroupService.name);

  private readonly loggingConfig = createLoggingConfig();
  constructor(
    private readonly prisma: PrismaService,
    private readonly admissionPolicy: CircleAdmissionPolicy,
    private readonly memberLock: CircleMemberLockService,
    private readonly chatCircleSync: ChatCircleSyncService,
    private readonly systemMessage: ChatSystemMessageService,
  ) {}

  async updateGroupMemberRole(
    actorId: string,
    groupID: string,
    targetUserID: string,
    dto: UpdateGroupMemberRoleDto,
  ): Promise<GroupMemberRoleResultDto> {
    const normalizedGroupID = this.normalizeGroupID(groupID);
    const normalizedTargetUserID = normalizeUserIdAlias(targetUserID.trim());
    if (!normalizedTargetUserID || normalizedTargetUserID === actorId) {
      throw new ForbiddenException({
        message: 'The group owner cannot change their own role',
        errorCode: GroupErrorCode.ManagerOnly,
      });
    }

    // includeDeleted:停用的圈子要能被查出来,好给群主一个「群已停用」的明确回复
    // (沿用默认的 deleted:false 过滤的话,已停用的群会退化成 404「群不存在」,
    // 群主分不清是自己记错了群还是群被停用)。
    //
    // 但**查出来不等于可以立刻据此回话**:停用状态只对已证明身份的群主披露,
    // 判定放在下面 preflightActor 之后。放在这里的话,任何登录用户拿一个圈子 ID
    // 试一次就能分辨「不存在(404)/ 已停用(独有文案)/ 正常(群主校验失败)」三态,
    // 等于把停用状态做成了对全站开放的探测接口 —— 而 preflightActor 的全部意义
    // 恰恰是「先鉴权再暴露任何东西」,在它前面开这个口等于把它架空。
    const circle = await this.findCircleByGroupID(normalizedGroupID, true);

    if (!circle) {
      // 自研栈下群 = 圈子;OpenIM 时代的裸群已不存在。
      throw new NotFoundException({
        message: 'Group not found',
        errorCode: GroupErrorCode.NotFound,
      });
    }

    const auditGroupID = this.auditGroupID(circle, normalizedGroupID);
    const roleResult = await runSerializableTransaction<{
      changed: boolean;
      message: ChatMessageDto | null;
    }>(this.prisma, async (tx) => {
      // 先鉴权,再取锁、再查目标。反过来的话:非群主也能让服务端为任意 userID
      // 取一遍成员锁并做一次存在性查询,错误信息的差异就成了「此人是否在群里」
      // 的探测接口,顺带还能拿锁竞争当侧信道。
      const preflightActor = await tx.circleMember.findUnique({
        where: {
          userID_circleID: { userID: actorId, circleID: circle.id },
        },
        select: { id: true, role: true, status: true },
      });
      if (
        !preflightActor ||
        preflightActor.status !== CircleMemberStatus.ACTIVE ||
        preflightActor.role !== CircleMemberRole.OWNER
      ) {
        throw new ForbiddenException({
          message: 'Only the group owner can change administrator roles',
          errorCode: GroupErrorCode.ManagerOnly,
        });
      }

      // 身份已证明,现在才可以披露停用状态。非群主走到上面那条统一回复为止,
      // 拿到的错误与「圈子正常但你不是群主」完全一致,分辨不出停用与否。
      // (下面 FOR UPDATE 那次复查针对的是并发窗口,与这次职责不同,两者都要留。)
      if (circle.deleted) {
        throw new ForbiddenException({
          message:
            'Administrator roles cannot be changed for an inactive group',
          errorCode: GroupErrorCode.ManagerOnly,
        });
      }

      await this.memberLock.lock(tx, circle.id, [
        actorId,
        normalizedTargetUserID,
      ]);
      // 事务内复查圈子是否已被停用,并对 Circle 行加锁。
      //
      // findCircleByGroupID 的 deleted:false 是在事务外筛的:管理员在那之后
      // 按下停用,本事务照样提权并写审计,给一个已停用的群返回成功。
      //
      // 只是重读一遍不够。事务是 SERIALIZABLE,但 SSI 要形成 dangerous structure
      // 才会中止,单独一条 rw 依赖(我读 Circle、别人写 Circle)并不必然触发。
      // FOR UPDATE 拿真实行锁才有确定语义:停用先提交 → 这里报 40001(P2034),
      // runSerializableTransaction 重试后读到 deleted=true 正常拒绝;本事务先
      // 拿到锁 → 停用阻塞到提交后生效,此时角色变更确实发生在停用之前,放行是对的。
      //
      // 位置必须在 memberLock 之后:removeGroupMember / leaveGroup 都是「先成员
      // advisory 锁、后 Circle 行锁」(circle.update 扣 memberCount),反过来加就
      // 和它们构成 ABBA 死锁。停用路径只写 Circle、不取成员锁,不参与成环。
      const [lockedCircle] = await tx.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT "deleted" FROM "Circle" WHERE "id" = ${circle.id} FOR UPDATE
      `;
      if (!lockedCircle || lockedCircle.deleted) {
        throw new ForbiddenException({
          message:
            'Administrator roles cannot be changed for an inactive group',
          errorCode: GroupErrorCode.ManagerOnly,
        });
      }

      const [actor, target] = await Promise.all([
        tx.circleMember.findUnique({
          where: {
            userID_circleID: { userID: actorId, circleID: circle.id },
          },
          select: { id: true, role: true, status: true },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: {
              userID: normalizedTargetUserID,
              circleID: circle.id,
            },
          },
          select: { id: true, role: true, status: true },
        }),
      ]);

      if (
        !actor ||
        actor.status !== CircleMemberStatus.ACTIVE ||
        actor.role !== CircleMemberRole.OWNER
      ) {
        throw new ForbiddenException({
          message: 'Only the group owner can change administrator roles',
          errorCode: GroupErrorCode.ManagerOnly,
        });
      }
      if (
        !target ||
        target.status !== CircleMemberStatus.ACTIVE ||
        target.role === CircleMemberRole.OWNER
      ) {
        throw new NotFoundException({
          message: 'Group member not found',
          errorCode: GroupErrorCode.MemberNotFound,
        });
      }

      const nextRole =
        dto.role === GroupMemberRoleInput.ADMIN
          ? CircleMemberRole.ADMIN
          : CircleMemberRole.MEMBER;
      if (target.role === nextRole) return { changed: false, message: null };

      await tx.circleMember.update({
        where: { id: target.id },
        data: { role: nextRole },
      });
      // review P2：特权变更留结构化审计（脱敏：只有 ID 与角色），与角色写同事务。
      await tx.adminAuditLog.create({
        data: {
          actorID: actorId,
          action: 'GROUP_MEMBER_ROLE_UPDATED',
          entityType: 'CircleMember',
          entityID: target.id,
          metadata: {
            circleID: circle.id,
            groupID: auditGroupID,
            targetUserID: normalizedTargetUserID,
            previousRole: target.role,
            newRole: nextRole,
          },
        },
      });
      let message: ChatMessageDto | null = null;
      const conversation = await tx.chatConversation.findUnique({
        where: { circleID: circle.id },
        select: { id: true },
      });
      if (conversation) {
        message = await this.systemMessage.insertSystemMessageInTx(
          tx,
          conversation.id,
          {
            kind: 'member-role-changed',
            actorId,
            targetUserId: normalizedTargetUserID,
            role: nextRole,
          },
        );
      }
      // 角色真值只在 CircleMember;聊天侧权限按圈子角色读时派生,无需外推。
      return { changed: true, message };
    });

    if (roleResult.message) {
      this.systemMessage.broadcastSystemMessage(roleResult.message);
    }

    if (roleResult.changed) {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'group_member_role_updated',
        actorId: actorId,
        targetId: normalizedTargetUserID,
        result: 'success',
        entityType: 'circle',
        entityId: circle.id,
        metadata: { newRole: dto.role },
      });
    }
    return { handled: true, role: dto.role };
  }

  async inviteGroupMembers(
    actorId: string,
    groupID: string,
    dto: InviteGroupMembersDto,
  ): Promise<GroupMemberSyncResult> {
    const normalizedGroupID = this.normalizeGroupID(groupID);
    const circle = await this.findCircleByGroupID(normalizedGroupID);

    if (!circle) {
      return { handled: false };
    }

    const targetUserIDs = this.uniqueIDs(dto.userIDs).filter(
      (userID) => userID !== actorId,
    );

    const auditGroupID = this.auditGroupID(circle, normalizedGroupID);
    let activatedCircleId: string | null = null;
    await runSerializableTransaction(this.prisma, async (tx) => {
      await this.memberLock.lock(tx, circle.id, [actorId, ...targetUserIDs]);
      const [actor, existingMemberships] = await Promise.all([
        tx.circleMember.findUnique({
          where: {
            userID_circleID: { userID: actorId, circleID: circle.id },
          },
          select: { id: true, role: true, status: true },
        }),
        tx.circleMember.findMany({
          where: {
            circleID: circle.id,
            userID: { in: targetUserIDs },
          },
          select: { userID: true, status: true },
        }),
      ]);
      this.assertCanManageCircleGroup(actor, null);

      const existingByUserID = new Map(
        existingMemberships.map((membership) => [
          membership.userID,
          membership.status,
        ]),
      );
      const invitableUserIDs = targetUserIDs.filter(
        (userID) => existingByUserID.get(userID) !== CircleMemberStatus.ACTIVE,
      );
      if (invitableUserIDs.length === 0) return;

      await this.assertInviteTargetsAllowInvites(tx, actorId, invitableUserIDs);
      // invitableUserIDs 是被 actorId 拉进群的其他人：加入上限被触发时错误回给
      // actorId，不能带上别人的额度细节。
      const activatingUserIDs = await this.admissionPolicy.activateMembers(
        tx,
        circle.id,
        invitableUserIDs,
        { locksHeld: true, actor: 'third-party' },
      );
      if (activatingUserIDs.length === 0) {
        return;
      }
      activatedCircleId = circle.id;
    });

    // 座位不等对账:激活提交后立刻触发一次幂等 ensure。
    // 失败必须排进对账重试队列,不能只记日志 —— 对账扫的是
    // `CircleMember.updatedAt` 的 2 分钟窗口,一次更久的数据库故障过后,
    // 这次激活早已滑出窗口,被邀请的人会一直是没有聊天座位的正式成员。
    // (邀请审批那条路径已经这么做了,这里漏了。)
    if (activatedCircleId) {
      const circleId = activatedCircleId;
      void this.chatCircleSync
        .ensureCircleConversation(circleId)
        .catch((error: unknown) => {
          this.chatCircleSync.scheduleRetry(circleId);
          this.logger.warn(
            `invite seat sync failed circle=${circleId} (queued for retry): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          reportOperationalError(error, {
            component: 'GroupService',
            operation: 'inviteGroupMembers',
            kind: 'chat_sync',
          });
        });
    }

    return { handled: true };
  }

  async removeGroupMember(
    actorId: string,
    groupID: string,
    targetUserID: string,
  ): Promise<GroupMemberSyncResult> {
    const normalizedGroupID = this.normalizeGroupID(groupID);
    const normalizedTargetUserID = targetUserID.trim();
    if (!normalizedTargetUserID) {
      throw new NotFoundException({
        message: 'Group member not found',
        errorCode: GroupErrorCode.MemberNotFound,
      });
    }

    const circle = await this.findCircleByGroupID(normalizedGroupID);
    if (!circle) {
      return { handled: false };
    }

    if (normalizedTargetUserID === actorId) {
      throw new ForbiddenException({
        message: 'Use the group leave endpoint for yourself',
        errorCode: GroupErrorCode.UseLeaveEndpoint,
      });
    }

    const auditGroupID = this.auditGroupID(circle, normalizedGroupID);
    const removalResult = await runSerializableTransaction<{
      conversationId: string | null;
      message: ChatMessageDto | null;
    }>(this.prisma, async (tx) => {
      let conversationId: string | null = null;
      let message: ChatMessageDto | null = null;
      await this.memberLock.lock(tx, circle.id, [
        actorId,
        normalizedTargetUserID,
      ]);
      const [actor, target] = await Promise.all([
        tx.circleMember.findUnique({
          where: {
            userID_circleID: { userID: actorId, circleID: circle.id },
          },
          select: { id: true, role: true, status: true },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: {
              userID: normalizedTargetUserID,
              circleID: circle.id,
            },
          },
          select: { id: true, role: true, status: true },
        }),
      ]);
      this.assertCanManageCircleGroup(actor, target);

      await tx.circleInvitation.updateMany({
        where: {
          circleID: circle.id,
          applicantID: normalizedTargetUserID,
          status: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      });

      if (target) {
        await tx.userDisplayIcon.deleteMany({
          where: { userID: normalizedTargetUserID, circleID: circle.id },
        });
        await tx.circleMember.delete({ where: { id: target.id } });
        // 踢人走 delete,对账的 updatedAt 窗口扫不到被删的行 —— 座位必须在同一
        // 事务里收掉,否则被踢的人照样能读能发、还继续收群消息。
        conversationId = await this.chatCircleSync.releaseSeatInTx(
          tx,
          circle.id,
          normalizedTargetUserID,
        );

        if (target.status === CircleMemberStatus.ACTIVE) {
          await tx.circle.update({
            where: { id: circle.id },
            data: { memberCount: { decrement: 1 } },
          });
        }

        const conversation = await tx.chatConversation.findUnique({
          where: { circleID: circle.id },
          select: { id: true },
        });
        if (conversation) {
          conversationId = conversation.id;
          message = await this.systemMessage.insertSystemMessageInTx(
            tx,
            conversation.id,
            {
              kind: 'member-removed',
              actorId,
              targetUserId: normalizedTargetUserID,
            },
          );
        }
      }

      await tx.conversationGroupMembership.deleteMany({
        where: {
          conversationID: {
            in: this.groupConversationIDCandidates(normalizedGroupID),
          },
          group: { ownerID: normalizedTargetUserID },
        },
      });
      return { conversationId, message };
    });
    if (removalResult.conversationId) {
      // await:离房完成之前不能宣布移除,否则这中间广播到会话房的消息
      // 那位已被移出的成员照样收得到(广播不会再查一次 ChatMember)。
      await this.chatCircleSync.detachSeat(
        normalizedTargetUserID,
        removalResult.conversationId,
        'removed',
        false,
      );
    }
    if (removalResult.message) {
      this.systemMessage.broadcastSystemMessage(removalResult.message);
    }

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'group_member_removed',
      actorId: actorId,
      targetId: normalizedTargetUserID,
      result: 'success',
      entityType: 'group',
      entityId: normalizedGroupID,
    });
    return { handled: true };
  }

  async leaveGroup(userId: string, groupID: string): Promise<void> {
    const normalizedGroupID = this.normalizeGroupID(groupID);

    const groupIDCandidates = this.groupIDCandidates(normalizedGroupID);
    const conversationIDs =
      this.groupConversationIDCandidates(normalizedGroupID);
    const circle = await this.prisma.circle.findFirst({
      where: {
        deleted: false,
        OR: [
          { id: normalizedGroupID },
          ...groupIDCandidates.map((candidate) => ({ groupID: candidate })),
        ],
      },
      select: { id: true, groupID: true, ownerID: true },
    });

    let leftConversationId: string | null = null;
    await runSerializableTransaction(this.prisma, async (tx) => {
      let membership: CircleGroupMemberLookup | null = null;
      if (circle) {
        await this.memberLock.lock(tx, circle.id, [userId]);
        membership = await tx.circleMember.findUnique({
          where: { userID_circleID: { userID: userId, circleID: circle.id } },
          select: { id: true, role: true, status: true },
        });
        if (
          circle.ownerID === userId ||
          membership?.role === CircleMemberRole.OWNER
        ) {
          throw new ForbiddenException({
            message: 'Owner cannot leave — transfer ownership first',
            errorCode: GroupErrorCode.OwnerCannotLeave,
          });
        }
        await tx.circleInvitation.updateMany({
          where: {
            circleID: circle.id,
            applicantID: userId,
            status: 'PENDING',
          },
          data: { status: 'CANCELLED' },
        });
      }

      await tx.conversationGroupMembership.deleteMany({
        where: {
          conversationID: { in: conversationIDs },
          group: { ownerID: userId },
        },
      });

      if (!circle || !membership) {
        return;
      }

      await tx.userDisplayIcon.deleteMany({
        where: { userID: userId, circleID: circle.id },
      });
      await tx.circleMember.delete({ where: { id: membership.id } });
      // 退群走 delete,对账的 updatedAt 窗口扫不到被删的行 —— 座位必须在同一
      // 事务里收掉,否则退群的人照样能读能发、还继续收群消息。
      leftConversationId = await this.chatCircleSync.releaseSeatInTx(
        tx,
        circle.id,
        userId,
      );

      if (membership.status === CircleMemberStatus.ACTIVE) {
        await tx.circle.update({
          where: { id: circle.id },
          data: { memberCount: { decrement: 1 } },
        });
      }
    });
    if (leftConversationId) {
      await this.chatCircleSync.detachSeat(userId, leftConversationId, 'left');
    }

    this.logger.log(`Group leave cleanup completed: ${userId} -> ${groupID}`);
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'group_left',
      actorId: userId,
      result: 'success',
      entityType: 'group',
      entityId: groupID,
    });
  }

  async reportGroup(
    reporterId: string,
    groupID: string,
    dto: ReportGroupDto,
  ): Promise<void> {
    const normalizedGroupID = groupID.trim();
    if (!normalizedGroupID) {
      throw new NotFoundException({
        message: 'Group not found',
        errorCode: GroupErrorCode.NotFound,
      });
    }
    const description = dto.description.trim();
    if (!description) {
      throw new BadRequestException({
        message: 'Report description cannot be empty',
        errorCode: GroupErrorCode.ReportDescEmpty,
      });
    }

    const circle = await this.prisma.circle.findFirst({
      where: {
        deleted: false,
        OR: [{ id: normalizedGroupID }, { groupID: normalizedGroupID }],
      },
      select: { id: true, groupID: true },
    });

    let reportGroupID = normalizedGroupID;
    let circleID: string | null = null;

    if (circle) {
      const membership = await this.prisma.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: reporterId,
            circleID: circle.id,
          },
        },
        select: { status: true },
      });

      if (membership?.status !== CircleMemberStatus.ACTIVE) {
        throw new ForbiddenException({
          message: 'Only active group members can report this group',
          errorCode: GroupErrorCode.ReportNotActive,
        });
      }
      circleID = circle.id;
    } else {
      // 自研栈下群 = 圈子;OpenIM 时代的裸群不再可举报。
      throw new NotFoundException({
        message: 'Group not found',
        errorCode: GroupErrorCode.NotFound,
      });
    }

    // 只挡「同一举报仍在 PENDING」的重复；APPROVED/REJECTED 审结后允许再次举报新事件
    // （与 GroupReport_pending_unique 局部唯一索引一致）。不限定 status 会把已审结的旧行
    // 也当重复、永久 409。
    const duplicate = await this.prisma.groupReport.findFirst({
      where: {
        reporterID: reporterId,
        groupID: reportGroupID,
        category: dto.category,
        status: ReportReviewStatus.PENDING,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException({
        message:
          'You have already submitted a report for this category against this group',
        errorCode: GroupErrorCode.ReportDuplicate,
      });
    }

    try {
      await this.prisma.groupReport.create({
        data: {
          reporterID: reporterId,
          groupID: reportGroupID,
          circleID,
          category: dto.category,
          description,
          evidence: dto.evidence ?? [],
        },
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message:
            'You have already submitted a report for this category against this group',
          errorCode: GroupErrorCode.ReportDuplicate,
        });
      }
      throw error;
    }

    this.logger.warn(
      `Group report submitted: ${reporterId} -> ${reportGroupID} (${dto.category})`,
    );
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'group_reported',
      actorId: reporterId,
      result: 'success',
      entityType: 'group',
      entityId: reportGroupID,
      metadata: { category: dto.category },
    });
  }

  private prismaErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  }

  /**
   * includeDeleted:调用方需要区分「群不存在」与「群已停用」时传 true。
   * 默认过滤掉 deleted —— 其余路径把停用群当作不存在处理即可。
   */
  private async findCircleByGroupID(
    groupID: string,
    includeDeleted = false,
  ): Promise<CircleGroupLookup | null> {
    const groupIDCandidates = this.groupIDCandidates(groupID);
    return this.prisma.circle.findFirst({
      where: {
        ...(includeDeleted ? {} : { deleted: false }),
        OR: [
          { id: groupID },
          ...groupIDCandidates.map((candidate) => ({ groupID: candidate })),
        ],
      },
      select: { id: true, groupID: true, ownerID: true, deleted: true },
    });
  }

  private assertCanManageCircleGroup(
    actor: CircleGroupMemberLookup | null,
    target: CircleGroupMemberLookup | null,
  ): void {
    if (!actor || actor.status !== CircleMemberStatus.ACTIVE) {
      throw new ForbiddenException({
        message: 'Only active group managers can do this',
        errorCode: GroupErrorCode.ManagerOnly,
      });
    }

    if (actor.role === CircleMemberRole.OWNER) {
      return;
    }

    if (
      actor.role === CircleMemberRole.ADMIN &&
      (!target || target.role === CircleMemberRole.MEMBER)
    ) {
      return;
    }

    throw new ForbiddenException({
      message: 'Only group managers can do this',
      errorCode: GroupErrorCode.ManagerOnly,
    });
  }

  private normalizeGroupID(groupID: string): string {
    const normalizedGroupID = groupID.trim();
    if (!normalizedGroupID) {
      throw new NotFoundException({
        message: 'Group not found',
        errorCode: GroupErrorCode.NotFound,
      });
    }
    return normalizedGroupID;
  }

  /** 审计元数据里的对外群号:沿用 Circle.groupID(=== circle.id),兼容历史行。 */
  private auditGroupID(circle: CircleGroupLookup, fallbackGroupID: string) {
    return circle.groupID ?? fallbackGroupID;
  }

  private async assertInviteTargetsAllowInvites(
    tx: Prisma.TransactionClient,
    inviterId: string,
    targetUserIDs: string[],
  ): Promise<void> {
    const [friendships, privacyRows] = await Promise.all([
      tx.friend.findMany({
        where: {
          state: 'ACCEPTED',
          OR: [
            { userID: inviterId, friendID: { in: targetUserIDs } },
            { friendID: inviterId, userID: { in: targetUserIDs } },
          ],
        },
        select: { userID: true, friendID: true },
      }),
      tx.userPrivacySetting.findMany({
        where: { userID: { in: targetUserIDs } },
        select: { userID: true, groupInvitePermission: true },
      }),
    ]);
    const friendSet = new Set(
      friendships.map((record) =>
        record.userID === inviterId ? record.friendID : record.userID,
      ),
    );
    const permissionByUserID = new Map(
      privacyRows.map((row) => [row.userID, row.groupInvitePermission]),
    );
    const blocked = targetUserIDs.some((targetUserID) => {
      const permission = permissionByUserID.get(targetUserID) ?? 'EVERYONE';
      return (
        permission === 'NONE' ||
        (permission === 'FRIENDS_ONLY' && !friendSet.has(targetUserID))
      );
    });
    if (blocked) {
      throw new ForbiddenException({
        message: 'User does not allow group invites',
        errorCode: GroupErrorCode.InviteNotAllowed,
      });
    }
  }

  private uniqueIDs(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  }

  private groupIDCandidates(groupID: string): string[] {
    return Array.from(
      new Set([
        groupID,
        groupID.startsWith('sg_') ? groupID.slice(3) : groupID,
      ]),
    );
  }

  private groupConversationIDCandidates(groupID: string): string[] {
    return Array.from(
      new Set([
        groupID,
        groupID.startsWith('sg_') ? groupID.slice(3) : `sg_${groupID}`,
      ]),
    );
  }
}
