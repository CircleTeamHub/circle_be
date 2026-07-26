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
import { InviteGroupMembersDto } from './dto/group-member.dto';
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
    private readonly openimService: OpenimService,
    private readonly admissionPolicy: CircleAdmissionPolicy,
    private readonly memberLock: CircleMemberLockService,
  ) {}

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
      const activatingUserIDs = await this.admissionPolicy.activateMembers(
        tx,
        circle.id,
        invitableUserIDs,
        { locksHeld: true },
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
