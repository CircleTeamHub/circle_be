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
import { CircleErrorCode, GroupErrorCode } from 'src/common/app-error-codes';
import { reserveCircleSeats } from 'src/circle/circle-capacity';
import { circleApplicationLockKey } from 'src/circle-invitation/circle-application-lock';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
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
    private readonly privacySettings: PrivacySettingsService,
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

    const actor = await this.getCircleMember(circle.id, actorId);
    this.assertCanManageCircleGroup(actor, null);

    const targetUserIDs = this.uniqueIDs(dto.userIDs).filter(
      (userID) => userID !== actorId,
    );

    if (targetUserIDs.length === 0) {
      return { handled: true };
    }

    // Pre-check only decides whether to run the privacy gate and open a
    // transaction; the authoritative read happens under the pair locks below.
    const existingMemberships = await this.prisma.circleMember.findMany({
      where: {
        circleID: circle.id,
        userID: { in: targetUserIDs },
      },
      select: { userID: true, status: true },
    });
    const existingByUserID = new Map(
      existingMemberships.map((membership) => [
        membership.userID,
        membership.status,
      ]),
    );
    const invitableUserIDs = targetUserIDs.filter(
      (userID) => existingByUserID.get(userID) !== CircleMemberStatus.ACTIVE,
    );

    if (invitableUserIDs.length === 0) {
      return { handled: true };
    }

    await this.assertInviteTargetsAllowInvites(actorId, invitableUserIDs);

    const openimGroupID = this.openimGroupID(circle, normalizedGroupID);
    await this.prisma.$transaction(async (tx) => {
      await this.lockCircleApplicationPairs(tx, circle.id, invitableUserIDs);

      // Re-read under the locks: the pre-check snapshot can be stale (a
      // concurrent join may have activated a target, or filled the last seat).
      const lockedMemberships = await tx.circleMember.findMany({
        where: {
          circleID: circle.id,
          userID: { in: invitableUserIDs },
        },
        select: { userID: true, status: true },
      });
      const lockedByUserID = new Map(
        lockedMemberships.map((membership) => [
          membership.userID,
          membership.status,
        ]),
      );
      const activatingUserIDs = invitableUserIDs.filter(
        (userID) => lockedByUserID.get(userID) !== CircleMemberStatus.ACTIVE,
      );
      if (activatingUserIDs.length === 0) {
        return;
      }

      const rejoiningUserIDs = activatingUserIDs.filter((userID) =>
        lockedByUserID.has(userID),
      );
      const newUserIDs = activatingUserIDs.filter(
        (userID) => !lockedByUserID.has(userID),
      );

      // memberCount is derived from what the writes actually changed, never
      // from the pre-check snapshot, so a row that raced to ACTIVE cannot be
      // counted twice.
      let seatsTaken = 0;
      if (rejoiningUserIDs.length > 0) {
        const reactivated = await tx.circleMember.updateMany({
          where: {
            circleID: circle.id,
            userID: { in: rejoiningUserIDs },
            status: { not: CircleMemberStatus.ACTIVE },
          },
          data: {
            role: CircleMemberRole.MEMBER,
            status: CircleMemberStatus.ACTIVE,
          },
        });
        seatsTaken += reactivated.count;
      }
      if (newUserIDs.length > 0) {
        const created = await tx.circleMember.createMany({
          data: newUserIDs.map((userID) => ({
            userID,
            circleID: circle.id,
            role: CircleMemberRole.MEMBER,
            status: CircleMemberStatus.ACTIVE,
          })),
          skipDuplicates: true,
        });
        seatsTaken += created.count;
      }

      if (seatsTaken > 0) {
        const reserved = await reserveCircleSeats(tx, circle.id, seatsTaken);
        if (!reserved) {
          const circleStillExists = await tx.circle.findUnique({
            where: { id: circle.id },
            select: { id: true },
          });
          if (!circleStillExists) {
            throw new NotFoundException({
              message: 'Circle not found',
              errorCode: GroupErrorCode.NotFound,
            });
          }
          throw new BadRequestException({
            message: 'Circle has reached its member limit',
            errorCode: CircleErrorCode.MemberLimit,
          });
        }
      }

      await tx.groupSyncOutbox.createMany({
        data: activatingUserIDs.map((userID) => ({
          operation: 'ADD_MEMBER',
          groupID: openimGroupID,
          userID,
        })),
        skipDuplicates: true,
      });
    });

    return { handled: true };
  }

  /**
   * Takes the (circle, user) advisory lock every other membership path takes,
   * for a whole batch in one round-trip. Keys are sorted so two concurrent
   * batches always acquire in the same order and cannot deadlock each other.
   */
  private async lockCircleApplicationPairs(
    tx: Prisma.TransactionClient,
    circleID: string,
    userIDs: string[],
  ): Promise<void> {
    const pairKeys = userIDs
      .map((userID) => circleApplicationLockKey(circleID, userID))
      // Any stable total order prevents the deadlock; code-unit order is the
      // right one here. localeCompare would vary with the runtime's locale,
      // which is exactly the inconsistency this sort exists to rule out.
      // eslint-disable-next-line sonarjs/no-alphabetical-sort
      .sort();
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(pairs.pair_key))
      FROM unnest(ARRAY[${Prisma.join(pairKeys)}]::text[]) AS pairs(pair_key)
    `;
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

    const actor = await this.getCircleMember(circle.id, actorId);
    const target = await this.getCircleMember(
      circle.id,
      normalizedTargetUserID,
    );
    this.assertCanManageCircleGroup(actor, target);

    const openimGroupID = this.openimGroupID(circle, normalizedGroupID);
    if (!target) {
      await this.prisma.$transaction(async (tx) => {
        await tx.conversationGroupMembership.deleteMany({
          where: {
            conversationID: {
              in: this.groupConversationIDCandidates(normalizedGroupID),
            },
            group: { ownerID: normalizedTargetUserID },
          },
        });
        await tx.groupSyncOutbox.createMany({
          data: [
            {
              operation: 'REMOVE_MEMBER',
              groupID: openimGroupID,
              userID: normalizedTargetUserID,
            },
          ],
          skipDuplicates: true,
        });
      });
      return { handled: true };
    }

    await this.prisma.$transaction(async (tx) => {
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

      await tx.conversationGroupMembership.deleteMany({
        where: {
          conversationID: {
            in: this.groupConversationIDCandidates(normalizedGroupID),
          },
          group: { ownerID: normalizedTargetUserID },
        },
      });

      await tx.groupSyncOutbox.createMany({
        data: [
          {
            operation: 'REMOVE_MEMBER',
            groupID: openimGroupID,
            userID: normalizedTargetUserID,
          },
        ],
        skipDuplicates: true,
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

    const membership = circle
      ? await this.prisma.circleMember.findUnique({
          where: { userID_circleID: { userID: userId, circleID: circle.id } },
          select: { id: true, role: true, status: true },
        })
      : null;

    if (
      circle &&
      (circle.ownerID === userId || membership?.role === CircleMemberRole.OWNER)
    ) {
      throw new ForbiddenException({
        message: 'Owner cannot leave — transfer ownership first',
        errorCode: GroupErrorCode.OwnerCannotLeave,
      });
    }

    await this.prisma.$transaction(async (tx) => {
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

    // review 修复：重复判定只看 PENDING —— 审结（APPROVED/REJECTED）后的
    // 再次举报是合法的新违规线索，必须能重新进入审核队列。局部唯一索引
    //（PENDING-only）兜住并发下的双 PENDING。
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

  private async getCircleMember(
    circleID: string,
    userID: string,
  ): Promise<CircleGroupMemberLookup | null> {
    return this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID, circleID } },
      select: { id: true, role: true, status: true },
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
    inviterId: string,
    targetUserIDs: string[],
  ) {
    // Resolve the inviter's friends once, then check each target in parallel.
    // Passing real friendship status keeps FRIENDS_ONLY invite permission
    // meaningful (hardcoding false would make it behave like NONE), and the
    // single friend query + Promise.all avoids the prior sequential N+1.
    const friendSet = new Set(await this.getAcceptedFriendIds(inviterId));
    const results = await Promise.all(
      targetUserIDs.map((targetUserID) =>
        this.privacySettings.canBeInvitedToGroupOrCircle(
          targetUserID,
          friendSet.has(targetUserID),
        ),
      ),
    );
    if (results.some((allowed) => !allowed)) {
      throw new ForbiddenException({
        message: 'User does not allow group invites',
        errorCode: GroupErrorCode.InviteNotAllowed,
      });
    }
  }

  private async getAcceptedFriendIds(userId: string): Promise<string[]> {
    const records = await this.prisma.friend.findMany({
      where: {
        OR: [{ userID: userId }, { friendID: userId }],
        state: 'ACCEPTED',
      },
      select: { userID: true, friendID: true },
    });
    return records.map((r) => (r.userID === userId ? r.friendID : r.userID));
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
