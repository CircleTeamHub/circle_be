import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CircleMemberRole, CircleMemberStatus } from 'src/generated/prisma';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
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
    const activatingUserIDs = targetUserIDs.filter(
      (userID) => existingByUserID.get(userID) !== CircleMemberStatus.ACTIVE,
    );

    if (activatingUserIDs.length === 0) {
      return { handled: true };
    }

    const openimGroupID = this.openimGroupID(circle, normalizedGroupID);
    await this.prisma.$transaction(async (tx) => {
      for (const userID of activatingUserIDs) {
        if (existingByUserID.has(userID)) {
          await tx.circleMember.update({
            where: {
              userID_circleID: {
                userID,
                circleID: circle.id,
              },
            },
            data: {
              role: CircleMemberRole.MEMBER,
              status: CircleMemberStatus.ACTIVE,
            },
          });
          continue;
        }

        await tx.circleMember.create({
          data: {
            userID,
            circleID: circle.id,
            role: CircleMemberRole.MEMBER,
            status: CircleMemberStatus.ACTIVE,
          },
        });
      }

      await tx.circle.update({
        where: { id: circle.id },
        data: { memberCount: { increment: activatingUserIDs.length } },
      });

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

  async removeGroupMember(
    actorId: string,
    groupID: string,
    targetUserID: string,
  ): Promise<GroupMemberSyncResult> {
    const normalizedGroupID = this.normalizeGroupID(groupID);
    const normalizedTargetUserID = targetUserID.trim();
    if (!normalizedTargetUserID) {
      throw new NotFoundException('Group member not found');
    }

    const circle = await this.findCircleByGroupID(normalizedGroupID);
    if (!circle) {
      return { handled: false };
    }

    if (normalizedTargetUserID === actorId) {
      throw new ForbiddenException('Use the group leave endpoint for yourself');
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
      throw new ForbiddenException(
        'Owner cannot leave — transfer ownership first',
      );
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
      throw new NotFoundException('Group not found');
    }
    const description = dto.description.trim();
    if (!description) {
      throw new BadRequestException('Report description cannot be empty');
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
        throw new ForbiddenException(
          'Only active group members can report this group',
        );
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
        throw new ServiceUnavailableException(
          'Group membership cannot be verified right now',
        );
      }

      if (!isMember) {
        throw new ForbiddenException('Only verified group members can report');
      }
    }

    const duplicate = await this.prisma.groupReport.findFirst({
      where: {
        reporterID: reporterId,
        groupID: reportGroupID,
        category: dto.category,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        'You have already submitted a report for this category against this group',
      );
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
        throw new ConflictException(
          'You have already submitted a report for this category against this group',
        );
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
      throw new ForbiddenException('Only active group managers can do this');
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

    throw new ForbiddenException('Only group managers can do this');
  }

  private normalizeGroupID(groupID: string): string {
    const normalizedGroupID = groupID.trim();
    if (!normalizedGroupID) {
      throw new NotFoundException('Group not found');
    }
    return normalizedGroupID;
  }

  private openimGroupID(circle: CircleGroupLookup, fallbackGroupID: string) {
    return circle.groupID ?? fallbackGroupID;
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
