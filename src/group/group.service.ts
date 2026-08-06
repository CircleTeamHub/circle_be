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

type GroupMemberSyncResult = { handled: boolean };
type CircleGroupLookup = {
  id: string;
  groupID: string | null;
  ownerID: string;
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
    const normalizedTargetUserID = normalizeUserIdAlias(targetUserID.trim());
    if (!normalizedTargetUserID || normalizedTargetUserID === actorId) {
      throw new ForbiddenException({
        message: 'The group owner cannot change their own role',
        errorCode: GroupErrorCode.ManagerOnly,
      });
    }

    const circle = await this.findCircleByGroupID(normalizedGroupID);

    if (!circle) {
      // 自研栈下群 = 圈子;OpenIM 时代的裸群已不存在。
      throw new NotFoundException({
        message: 'Group not found',
        errorCode: GroupErrorCode.NotFound,
      });
    }

    const auditGroupID = this.auditGroupID(circle, normalizedGroupID);
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
      // 角色真值只在 CircleMember;聊天侧权限按圈子角色读时派生,无需外推。
    });

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

    const auditGroupID = this.auditGroupID(circle, normalizedGroupID);
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
  }

  private prismaErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  }

  private async findCircleByGroupID(
    groupID: string,
  ): Promise<CircleGroupLookup | null> {
    const groupIDCandidates = this.groupIDCandidates(groupID);
    return this.prisma.circle.findFirst({
      where: {
        deleted: false,
        OR: [
          { id: groupID },
          ...groupIDCandidates.map((candidate) => ({ groupID: candidate })),
        ],
      },
      select: { id: true, groupID: true, ownerID: true },
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
