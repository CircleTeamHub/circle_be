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
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { enqueueCircleMemberSync } from 'src/circle/circle-member-sync';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  GroupMemberRoleInput,
  GroupMemberRoleResultDto,
  InviteGroupMembersDto,
  UpdateGroupMemberRoleDto,
} from './dto/group-member.dto';
import { ReportGroupDto } from './dto/group-report.dto';

type GroupMemberSyncResult = { handled: boolean };
type CircleGroupLookup = {
  id: string;
  groupID: string | null;
  ownerID: string;
  deleted?: boolean;
};

type CircleGroupMemberLookup = {
  id: string;
  role: CircleMemberRole;
  status: CircleMemberStatus;
};

@Injectable()
export class GroupService {
  private readonly logger = new Logger(GroupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
    private readonly admissionPolicy: CircleAdmissionPolicy,
    private readonly memberLock: CircleMemberLockService,
  ) {}

  async updateGroupMemberRole(
    actorId: string,
    groupID: string,
    targetUserID: string,
    dto: UpdateGroupMemberRoleDto,
  ): Promise<GroupMemberRoleResultDto> {
    const normalizedGroupID = this.normalizeGroupID(groupID);
    const normalizedTargetUserID = OpenimService.fromImUserId(
      targetUserID.trim(),
    );
    if (!normalizedTargetUserID || normalizedTargetUserID === actorId) {
      throw new ForbiddenException({
        message: 'The group owner cannot change their own role',
        errorCode: GroupErrorCode.ManagerOnly,
      });
    }

    const circle = await this.findCircleByGroupID(normalizedGroupID, true);
    const roleLevel = dto.role === GroupMemberRoleInput.ADMIN ? 60 : 20;

    if (circle?.deleted) {
      throw new ForbiddenException({
        message: 'Administrator roles cannot be changed for an inactive group',
        errorCode: GroupErrorCode.ManagerOnly,
      });
    }

    if (!circle) {
      return this.updateRawGroupMemberRole(
        actorId,
        this.rawOpenimGroupID(normalizedGroupID),
        normalizedTargetUserID,
        dto,
        roleLevel,
      );
    }

    const openimGroupID = this.openimGroupID(circle, normalizedGroupID);
    // review P1：先落库（角色 + outbox + 审计原子提交），OpenIM 放到提交后。
    // 旧顺序在事务内先调 OpenIM，提交失败会回滚本地状态而外部已提权。
    await runSerializableTransaction(this.prisma, async (tx) => {
      await this.memberLock.lock(tx, circle.id, [actorId]);
      const actor = await tx.circleMember.findUnique({
        where: {
          userID_circleID: { userID: actorId, circleID: circle.id },
        },
        select: { id: true, role: true, status: true },
      });

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

      await this.memberLock.lock(tx, circle.id, [normalizedTargetUserID]);
      const target = await tx.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: normalizedTargetUserID,
            circleID: circle.id,
          },
        },
        select: { id: true, role: true, status: true },
      });

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
            groupID: openimGroupID,
            targetUserID: normalizedTargetUserID,
            previousRole: target.role,
            newRole: nextRole,
          },
        },
      });
      // ADD_MEMBER 的 outbox 语义 = 「成员在群里且角色与 DB 一致」；提交后由
      // processor 兜底收敛 OpenIM，本地权限真值不依赖外呼成功。
      await enqueueCircleMemberSync(tx, 'ADD_MEMBER', openimGroupID, [
        normalizedTargetUserID,
      ]);
    });

    // 提交成功后立即推一把 OpenIM（快路径）；失败不回滚也不报错——outbox
    // 会以 DB 真值重试直到收敛。review R2：推送前重读已提交的角色而非请求参数
    // ——并发升/降级时本请求可能不是最后提交者，推参数会把旧角色写回 OpenIM。
    try {
      const committed = await this.prisma.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: normalizedTargetUserID,
            circleID: circle.id,
          },
        },
        select: { role: true, status: true },
      });
      if (
        committed?.status === CircleMemberStatus.ACTIVE &&
        committed.role !== CircleMemberRole.OWNER
      ) {
        await this.openimService.setGroupMemberRole(
          openimGroupID,
          normalizedTargetUserID,
          committed.role === CircleMemberRole.ADMIN ? 60 : 20,
        );
      }
    } catch (error) {
      this.logger.warn(
        `OpenIM role push deferred to outbox for group ${openimGroupID}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { handled: true, role: dto.role };
  }

  private async updateRawGroupMemberRole(
    actorId: string,
    openimGroupID: string,
    targetUserID: string,
    dto: UpdateGroupMemberRoleDto,
    roleLevel: 20 | 60,
  ): Promise<GroupMemberRoleResultDto> {
    // review P2：裸 OpenIM 群没有本地状态，OpenIM 故障要映射成稳定的 503
    // （与 reportGroup 的裸群成员校验先例一致），而不是裸抛 500。
    // review R2：群/成员不存在类错误不是故障——归一成 null 走下面的 403/404
    // 拒绝路径，只有真正的依赖故障才 503。
    const lookupRole = async (
      userID: string,
    ): Promise<20 | 60 | 100 | null> => {
      try {
        return await this.openimService.getGroupMemberRole(
          openimGroupID,
          userID,
        );
      } catch (error) {
        if (this.isOpenimNotFoundError(error)) return null;
        this.logger.warn(
          `Failed to verify raw OpenIM group roles for group ${openimGroupID}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw new ServiceUnavailableException({
          message: 'Group membership cannot be verified right now',
          errorCode: GroupErrorCode.MembershipVerifyUnavailable,
        });
      }
    };
    const actorRole = await lookupRole(actorId);
    if (actorRole !== 100) {
      throw new ForbiddenException({
        message: 'Only the group owner can change administrator roles',
        errorCode: GroupErrorCode.ManagerOnly,
      });
    }
    const targetRole = await lookupRole(targetUserID);
    if (targetRole !== 20 && targetRole !== 60) {
      throw new NotFoundException({
        message: 'Group member not found',
        errorCode: GroupErrorCode.MemberNotFound,
      });
    }

    try {
      await this.openimService.setGroupMemberRole(
        openimGroupID,
        targetUserID,
        roleLevel,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to update raw OpenIM group role for group ${openimGroupID}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException({
        message: 'Group role cannot be updated right now',
        errorCode: GroupErrorCode.MembershipVerifyUnavailable,
      });
    }

    // review P2/R2：裸群同样留审计，且审计不可静默丢——写失败就让整个请求
    // 失败（角色 set 幂等，客户端重试会重放同一角色并重试审计，最终两者都齐），
    // 绝不返回一个没有审计痕迹的成功。
    await this.prisma.adminAuditLog.create({
      data: {
        actorID: actorId,
        action: 'GROUP_MEMBER_ROLE_UPDATED',
        entityType: 'OpenimGroup',
        entityID: openimGroupID,
        metadata: {
          groupID: openimGroupID,
          targetUserID,
          previousRoleLevel: targetRole,
          newRoleLevel: roleLevel,
          newRole: dto.role,
        },
      },
    });

    return { handled: true, role: dto.role };
  }

  /**
   * OpenIM 「查无此群/此成员」类错误。这是业务上的拒绝信号（403/404），
   * 不是依赖故障，调用方不应把它映射成可重试的 503。
   */
  private isOpenimNotFoundError(error: unknown): boolean {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).toLowerCase();
    return (
      message.includes('recordnotfound') ||
      message.includes('record not found') ||
      message.includes('not exist') ||
      message.includes('not in group') ||
      message.includes('not group member')
    );
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

    const openimGroupID = this.openimGroupID(circle, normalizedGroupID);
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

      await enqueueCircleMemberSync(
        tx,
        'ADD_MEMBER',
        openimGroupID,
        activatingUserIDs,
      );
    });

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

    const openimGroupID = this.openimGroupID(circle, normalizedGroupID);
    await runSerializableTransaction(this.prisma, async (tx) => {
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

        if (target.status === CircleMemberStatus.ACTIVE) {
          await tx.circle.update({
            where: { id: circle.id },
            data: { memberCount: { decrement: 1 } },
          });
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

      await enqueueCircleMemberSync(tx, 'REMOVE_MEMBER', openimGroupID, [
        normalizedTargetUserID,
      ]);
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
        if (circle) {
          await enqueueCircleMemberSync(
            tx,
            'REMOVE_MEMBER',
            this.openimGroupID(circle, normalizedGroupID),
            [userId],
          );
        }
        return;
      }

      await tx.userDisplayIcon.deleteMany({
        where: { userID: userId, circleID: circle.id },
      });
      await tx.circleMember.delete({ where: { id: membership.id } });

      if (membership.status === CircleMemberStatus.ACTIVE) {
        await tx.circle.update({
          where: { id: circle.id },
          data: { memberCount: { decrement: 1 } },
        });
      }
      await enqueueCircleMemberSync(
        tx,
        'REMOVE_MEMBER',
        this.openimGroupID(circle, normalizedGroupID),
        [userId],
      );
    });

    this.logger.log(`Group leave cleanup completed: ${userId} -> ${groupID}`);
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
      reportGroupID = this.rawOpenimGroupID(normalizedGroupID);
      let isMember = false;
      try {
        isMember = await this.openimService.isGroupMember(
          reportGroupID,
          reporterId,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to verify raw OpenIM group membership for ${reporterId} -> ${reportGroupID}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw new ServiceUnavailableException({
          message: 'Group membership cannot be verified right now',
          errorCode: GroupErrorCode.MembershipVerifyUnavailable,
        });
      }

      if (!isMember) {
        throw new ForbiddenException({
          message: 'Only verified group members can report',
          errorCode: GroupErrorCode.ReportNotVerified,
        });
      }
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
  }

  private prismaErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  }

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

  private openimGroupID(circle: CircleGroupLookup, fallbackGroupID: string) {
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

  private rawOpenimGroupID(groupID: string): string {
    return groupID.startsWith('sg_') ? groupID.slice(3) : groupID;
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
