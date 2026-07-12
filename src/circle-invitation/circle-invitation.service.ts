import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from 'src/generated/prisma';
import {
  CircleErrorCode,
  CircleInvitationErrorCode,
} from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenimService } from 'src/openim/openim.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { NotificationService } from 'src/notification/notification.service';
import {
  InvitationDto,
  InvitationVerifierDto,
} from './dto/circle-invitation.dto';
import { circleApplicationLockKey } from './circle-application-lock';

const MAX_INVITATION_TX_ATTEMPTS = 3;

type CircleInvitationNotificationData = {
  toUserID: string;
  fromUserID: string;
  type:
    | 'CIRCLE_VERIFICATION_REQUESTED'
    | 'CIRCLE_INVITATION_APPROVED'
    | 'CIRCLE_INVITATION_REJECTED'
    | 'CIRCLE_ADMIN_OVERRIDE_APPROVED';
  fromCircleID: string;
  fromInvitationID: string;
};

// Single include shape reused by loadInvitation and the list queries so the
// list endpoints can hydrate in one round-trip instead of N+1.
const INVITATION_INCLUDE = {
  circle: true,
  applicant: true,
  inviter: true,
  verifiers: {
    include: { verifier: true },
    orderBy: { createdAt: 'asc' },
  },
} as const;

@Injectable()
export class CircleInvitationService {
  private readonly logger = new Logger(CircleInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
    private readonly realtimeService: RealtimeService,
    private readonly privacySettings: PrivacySettingsService,
    private readonly notificationService: NotificationService,
  ) {}

  async invite(
    inviterId: string,
    applicantId: string,
    circleId: string,
  ): Promise<InvitationDto> {
    // 1. Verify inviter is active member
    const inviterMembership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: inviterId, circleID: circleId } },
    });
    if (!inviterMembership || inviterMembership.status !== 'ACTIVE') {
      throw new ForbiddenException({
        message: 'You must be an active member to invite others',
        errorCode: CircleInvitationErrorCode.InviterNotMember,
      });
    }

    // 2. Verify applicant is NOT already a member
    const applicantMembership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: applicantId, circleID: circleId } },
    });
    if (applicantMembership?.status === 'ACTIVE') {
      throw new ConflictException({
        message: 'User is already a member of this circle',
        errorCode: CircleErrorCode.AlreadyMember,
      });
    }

    // 4. Verify circle capacity
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, deleted: false },
    });
    if (!circle) {
      throw new NotFoundException({
        message: 'Circle not found',
        errorCode: CircleErrorCode.NotFound,
      });
    }
    if (circle.maxMembers != null && circle.memberCount >= circle.maxMembers) {
      throw new BadRequestException({
        message: 'Circle has reached its member limit',
        errorCode: CircleErrorCode.MemberLimit,
      });
    }

    // 5. Verify applicant meets join restrictions
    const applicant = await this.prisma.user.findUnique({
      where: { id: applicantId },
      select: { vipLevel: true, creditScore: true, fancyNumber: true },
    });
    if (!applicant) {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: CircleErrorCode.UserNotFound,
      });
    }

    if (
      circle.joinVipRestriction != null &&
      applicant.vipLevel < circle.joinVipRestriction
    ) {
      throw new ForbiddenException({
        message: `Applicant needs VIP ${circle.joinVipRestriction}+ to join`,
        errorCode: CircleErrorCode.JoinVipRequired,
      });
    }
    if (
      circle.joinCreditRestriction != null &&
      applicant.creditScore < circle.joinCreditRestriction
    ) {
      throw new ForbiddenException({
        message: `Applicant needs credit score ${circle.joinCreditRestriction}+ to join`,
        errorCode: CircleErrorCode.JoinCreditRequired,
      });
    }
    if (circle.joinFancyRestriction && !applicant.fancyNumber) {
      throw new ForbiddenException({
        message: 'Applicant needs a fancy number to join',
        errorCode: CircleErrorCode.JoinFancyNumberRequired,
      });
    }

    // Pass real friendship status: a FRIENDS_ONLY invite permission must let
    // friends through. Hardcoding false here would collapse FRIENDS_ONLY into
    // NONE and block invites even from friends.
    const inviterIsFriend = await this.areFriends(inviterId, applicantId);
    const canInviteApplicant =
      await this.privacySettings.canBeInvitedToGroupOrCircle(
        applicantId,
        inviterIsFriend,
      );
    if (!canInviteApplicant) {
      throw new ForbiddenException({
        message: 'User does not allow circle invites',
        errorCode: CircleInvitationErrorCode.NotAllowed,
      });
    }

    // 6. Create invitation + auto-approve inviter as first verifier
    const invitation = await this.prisma.$transaction(async (tx) => {
      // CircleInvitation has no DB-level unique constraint, so serialize
      // concurrent invites for the same (circle, applicant) pair with a
      // transaction-scoped advisory lock, then re-check inside the lock.
      const pairKey = circleApplicationLockKey(circleId, applicantId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

      const lockedMembership = await tx.circleMember.findUnique({
        where: {
          userID_circleID: { userID: applicantId, circleID: circleId },
        },
      });
      if (lockedMembership?.status === 'ACTIVE') {
        throw new ConflictException({
          message: 'User is already a member of this circle',
          errorCode: CircleErrorCode.AlreadyMember,
        });
      }

      const existingInvitation = await tx.circleInvitation.findFirst({
        where: {
          circleID: circleId,
          applicantID: applicantId,
          status: 'PENDING',
        },
      });
      if (existingInvitation) {
        throw new ConflictException({
          message: 'There is already a pending invitation for this user',
          errorCode: CircleInvitationErrorCode.AlreadyPending,
        });
      }

      const created = await tx.circleInvitation.create({
        data: {
          circleID: circleId,
          applicantID: applicantId,
          inviterID: inviterId,
          approvedCount: 1,
        },
        include: {
          circle: true,
          applicant: true,
          inviter: true,
        },
      });

      await tx.circleInvitationVerifier.create({
        data: {
          invitationID: created.id,
          verifierID: inviterId,
          addedByID: inviterId,
          status: 'APPROVED',
          respondedAt: new Date(),
        },
      });

      return created;
    });

    return this.fetchInvitationDto(invitation.id);
  }

  async addVerifier(
    callerId: string,
    invitationId: string,
    verifierId: string,
  ): Promise<void> {
    const notificationData = await this.runInvitationTransaction(async (tx) => {
      const invitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { verifiers: true },
      });
      if (!invitation) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }

      // Only the applicant can add verifiers
      if (invitation.applicantID !== callerId) {
        throw new ForbiddenException({
          message: 'Only the applicant can add verifiers',
          errorCode: CircleInvitationErrorCode.ApplicantOnly,
        });
      }
      if (invitation.status !== 'PENDING') {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }

      // Verify the verifier is an active circle member
      const membership = await tx.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: verifierId,
            circleID: invitation.circleID,
          },
        },
      });
      if (!membership || membership.status !== 'ACTIVE') {
        throw new BadRequestException({
          message: '验证人必须是本圈子的活跃成员，请更换验证人再尝试',
          errorCode: CircleInvitationErrorCode.VerifierNotMember,
        });
      }

      const existingVerifier = invitation.verifiers.find(
        (verifier) => verifier.verifierID === verifierId,
      );
      if (existingVerifier) {
        throw new ConflictException({
          message: 'This user is already a verifier',
          errorCode: CircleInvitationErrorCode.AlreadyVerifier,
        });
      }

      const activeSlots = invitation.verifiers.filter(
        (verifier) => verifier.status !== 'REJECTED',
      ).length;
      if (activeSlots >= invitation.requiredCount) {
        throw new BadRequestException({
          message: 'All verification slots are filled',
          errorCode: CircleInvitationErrorCode.SlotsFilled,
        });
      }

      await tx.circleInvitationVerifier.create({
        data: {
          invitationID: invitationId,
          verifierID: verifierId,
          addedByID: callerId,
          status: 'PENDING',
        },
      });

      return {
        toUserID: verifierId,
        fromUserID: callerId,
        type: 'CIRCLE_VERIFICATION_REQUESTED' as const,
        fromCircleID: invitation.circleID,
        fromInvitationID: invitationId,
      };
    });

    await this.createAndBroadcastInvitationNotification(notificationData);
  }

  async respond(
    verifierId: string,
    invitationId: string,
    approve: boolean,
  ): Promise<void> {
    const result = await this.runInvitationTransaction(async (tx) => {
      const application = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        select: { circleID: true, applicantID: true },
      });
      if (!application) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }
      const pairKey = circleApplicationLockKey(
        application.circleID,
        application.applicantID,
      );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

      const [verifierRecord, invitation] = await Promise.all([
        tx.circleInvitationVerifier.findFirst({
          where: {
            invitationID: invitationId,
            verifierID: verifierId,
            status: 'PENDING',
          },
        }),
        tx.circleInvitation.findUnique({
          where: { id: invitationId },
          include: { circle: true },
        }),
      ]);
      if (!verifierRecord) {
        throw new NotFoundException({
          message: 'No pending verification found for you',
          errorCode: CircleInvitationErrorCode.NoPendingVerification,
        });
      }
      if (!invitation || invitation.status !== 'PENDING') {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }

      await tx.circleInvitationVerifier.update({
        where: { id: verifierRecord.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          respondedAt: new Date(),
        },
      });

      if (!approve) {
        return {
          admission: null,
          notificationData: {
            toUserID: invitation.applicantID,
            fromUserID: verifierId,
            type: 'CIRCLE_INVITATION_REJECTED' as const,
            fromCircleID: invitation.circleID,
            fromInvitationID: invitationId,
          },
        };
      }

      const updatedRows = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { approvedCount: { increment: 1 } },
      });
      if (updatedRows.count === 0) {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }

      const updatedInvitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { circle: true },
      });
      if (!updatedInvitation) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }

      if (updatedInvitation.approvedCount < updatedInvitation.requiredCount) {
        return { admission: null, notificationData: null };
      }

      const finalized = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'APPROVED' },
      });
      if (finalized.count === 0) {
        return { admission: null, notificationData: null };
      }

      const admitted = await this.admitApplicant(
        tx,
        updatedInvitation.circleID,
        updatedInvitation.applicantID,
      );

      return {
        admission: admitted
          ? {
              applicantId: updatedInvitation.applicantID,
              groupID: updatedInvitation.circle.groupID,
            }
          : null,
        notificationData: {
          toUserID: updatedInvitation.applicantID,
          fromUserID: verifierId,
          type: 'CIRCLE_INVITATION_APPROVED' as const,
          fromCircleID: updatedInvitation.circleID,
          fromInvitationID: invitationId,
        },
      };
    });

    await this.syncApplicantToGroup(
      result.admission?.groupID ?? null,
      result.admission?.applicantId,
    );

    const notificationTarget = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      select: { applicantID: true, circleID: true },
    });

    if (notificationTarget?.applicantID) {
      if (result.notificationData) {
        await this.createAndBroadcastInvitationNotification(
          result.notificationData,
        );
      }
      this.realtimeService.broadcastCircleInvitationReviewed(
        notificationTarget.applicantID,
        {
          invitationId,
          circleId: notificationTarget.circleID,
          status: approve ? 'APPROVED' : 'REJECTED',
        },
      );
    }
  }

  async adminApprove(adminId: string, invitationId: string): Promise<void> {
    const invitation = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      select: { circleID: true },
    });
    if (!invitation) {
      throw new NotFoundException({
        message: 'Invitation not found',
        errorCode: CircleInvitationErrorCode.NotFound,
      });
    }

    // Verify caller is OWNER or ADMIN
    const membership = await this.prisma.circleMember.findUnique({
      where: {
        userID_circleID: { userID: adminId, circleID: invitation.circleID },
      },
    });
    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      (membership.role !== 'OWNER' && membership.role !== 'ADMIN')
    ) {
      throw new ForbiddenException({
        message: 'Only circle owner or admin can override',
        errorCode: CircleInvitationErrorCode.OwnerAdminOnly,
      });
    }

    const result = await this.runInvitationTransaction(async (tx) => {
      const application = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        select: { circleID: true, applicantID: true },
      });
      if (!application) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }
      const pairKey = circleApplicationLockKey(
        application.circleID,
        application.applicantID,
      );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

      const pendingInvitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { circle: true },
      });
      if (!pendingInvitation) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }
      if (pendingInvitation.status !== 'PENDING') {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }

      const finalized = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'ADMIN_APPROVED' },
      });
      if (finalized.count === 0) {
        return { admission: null, notificationData: null };
      }

      const admitted = await this.admitApplicant(
        tx,
        pendingInvitation.circleID,
        pendingInvitation.applicantID,
      );

      return {
        admission: admitted
          ? {
              applicantId: pendingInvitation.applicantID,
              groupID: pendingInvitation.circle.groupID,
            }
          : null,
        notificationData: {
          toUserID: pendingInvitation.applicantID,
          fromUserID: adminId,
          type: 'CIRCLE_ADMIN_OVERRIDE_APPROVED' as const,
          fromCircleID: pendingInvitation.circleID,
          fromInvitationID: invitationId,
        },
      };
    });

    await this.syncApplicantToGroup(
      result.admission?.groupID ?? null,
      result.admission?.applicantId,
    );

    const notificationTarget = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      select: { applicantID: true },
    });

    if (notificationTarget?.applicantID) {
      if (result.notificationData) {
        await this.createAndBroadcastInvitationNotification(
          result.notificationData,
        );
      }
      this.realtimeService.broadcastCircleInvitationReviewed(
        notificationTarget.applicantID,
        {
          invitationId,
          circleId: invitation.circleID,
          status: 'ADMIN_APPROVED',
        },
      );
    }
  }

  /**
   * Repairs invitations that crossed the approval threshold while the
   * request transaction was interrupted. This intentionally uses the same
   * admission transaction and side effects as a verifier approval, so a
   * restart cannot leave a permanently pending invitation with a full set of
   * approvals.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileApprovedInvitations(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<
      Array<{ id: string; circleID: string; applicantID: string }>
    >`
      SELECT "id", "circleID", "applicantID"
      FROM "CircleInvitation"
      WHERE "status" = 'PENDING'
        AND "approvedCount" >= "requiredCount"
      ORDER BY "updatedAt" ASC, "id" ASC
      LIMIT 100
    `;
    let finalizedCount = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.runInvitationTransaction(async (tx) => {
          const pairKey = circleApplicationLockKey(
            candidate.circleID,
            candidate.applicantID,
          );
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

          const invitation = await tx.circleInvitation.findUnique({
            where: { id: candidate.id },
            include: { circle: true },
          });
          if (
            !invitation ||
            invitation.status !== 'PENDING' ||
            invitation.approvedCount < invitation.requiredCount
          ) {
            return null;
          }
          const changed = await tx.circleInvitation.updateMany({
            where: { id: invitation.id, status: 'PENDING' },
            data: { status: 'APPROVED' },
          });
          if (changed.count === 0) return null;
          const admitted = await this.admitApplicant(
            tx,
            invitation.circleID,
            invitation.applicantID,
          );
          return {
            admitted,
            applicantId: invitation.applicantID,
            circleId: invitation.circleID,
            groupID: invitation.circle.groupID,
            notificationData: {
              toUserID: invitation.applicantID,
              fromUserID: invitation.inviterID,
              type: 'CIRCLE_INVITATION_APPROVED' as const,
              fromCircleID: invitation.circleID,
              fromInvitationID: invitation.id,
            },
          };
        });
        if (!result) continue;
        finalizedCount += 1;
        await this.syncApplicantToGroup(
          result.admitted ? result.groupID : null,
          result.admitted ? result.applicantId : undefined,
        );
        await this.createAndBroadcastInvitationNotification(
          result.notificationData,
        );
        this.realtimeService.broadcastCircleInvitationReviewed(
          result.applicantId,
          {
            invitationId: candidate.id,
            circleId: result.circleId,
            status: 'APPROVED',
          },
        );
      } catch (error) {
        this.logger.warn(
          `Circle invitation reconciliation failed for ${candidate.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return finalizedCount;
  }

  async getInvitationForViewer(
    viewerId: string,
    invitationId: string,
  ): Promise<InvitationDto> {
    const inv = await this.loadInvitation(invitationId);
    await this.assertCanViewInvitation(viewerId, inv);
    return this.toInvitationDto(inv);
  }

  private async fetchInvitationDto(
    invitationId: string,
  ): Promise<InvitationDto> {
    const inv = await this.loadInvitation(invitationId);
    return this.toInvitationDto(inv);
  }

  async getMyPendingVerifications(userId: string): Promise<InvitationDto[]> {
    // Single hydrated query — no N+1 over individual invitation loads.
    const invitations = await this.prisma.circleInvitation.findMany({
      where: {
        status: 'PENDING',
        verifiers: { some: { verifierID: userId, status: 'PENDING' } },
      },
      orderBy: { createdAt: 'desc' },
      include: INVITATION_INCLUDE,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  async getMyApplications(userId: string): Promise<InvitationDto[]> {
    const invitations = await this.prisma.circleInvitation.findMany({
      where: { applicantID: userId },
      orderBy: { createdAt: 'desc' },
      include: INVITATION_INCLUDE,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  async getPendingInvitationsForCircle(
    adminId: string,
    circleId: string,
  ): Promise<InvitationDto[]> {
    // Verify admin role
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: adminId, circleID: circleId } },
    });
    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      (membership.role !== 'OWNER' && membership.role !== 'ADMIN')
    ) {
      throw new ForbiddenException({
        message: 'Only circle owner or admin can view',
        errorCode: CircleInvitationErrorCode.OwnerAdminOnly,
      });
    }

    const invitations = await this.prisma.circleInvitation.findMany({
      where: { circleID: circleId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      include: INVITATION_INCLUDE,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  private async loadInvitation(invitationId: string) {
    const inv = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      include: INVITATION_INCLUDE,
    });
    if (!inv) {
      throw new NotFoundException({
        message: 'Invitation not found',
        errorCode: CircleInvitationErrorCode.NotFound,
      });
    }
    return inv;
  }

  private toInvitationDto(
    inv: Awaited<ReturnType<CircleInvitationService['loadInvitation']>>,
  ): InvitationDto {
    return {
      id: inv.id,
      circleId: inv.circleID,
      circleName: inv.circle.name,
      applicant: {
        id: inv.applicant.id,
        nickname: inv.applicant.nickname,
        avatarUrl: inv.applicant.avatarUrl,
        accountId: inv.applicant.accountId,
      },
      inviter: {
        id: inv.inviter.id,
        nickname: inv.inviter.nickname,
        avatarUrl: inv.inviter.avatarUrl,
        accountId: inv.inviter.accountId,
      },
      requiredCount: inv.requiredCount,
      approvedCount: inv.approvedCount,
      status: inv.status,
      verifiers: inv.verifiers.map(
        (v): InvitationVerifierDto => ({
          id: v.id,
          verifier: {
            id: v.verifier.id,
            nickname: v.verifier.nickname,
            avatarUrl: v.verifier.avatarUrl,
            accountId: v.verifier.accountId,
          },
          status: v.status,
          respondedAt: v.respondedAt?.toISOString() ?? null,
        }),
      ),
      createdAt: inv.createdAt.toISOString(),
    };
  }

  private async admitApplicant(
    tx: any,
    circleId: string,
    applicantId: string,
  ): Promise<boolean> {
    // Create or update membership
    const existing = await tx.circleMember.findUnique({
      where: { userID_circleID: { userID: applicantId, circleID: circleId } },
    });

    const circle = await tx.circle.findUnique({
      where: { id: circleId },
      select: { maxMembers: true, memberCount: true },
    });
    if (!circle) {
      throw new NotFoundException({
        message: 'Circle not found',
        errorCode: CircleErrorCode.NotFound,
      });
    }

    const needsSeat = !existing || existing.status !== 'ACTIVE';
    if (
      needsSeat &&
      circle.maxMembers != null &&
      circle.memberCount >= circle.maxMembers
    ) {
      throw new BadRequestException({
        message: 'Circle has reached its member limit',
        errorCode: CircleErrorCode.MemberLimit,
      });
    }

    if (existing) {
      if (existing.status === 'ACTIVE') {
        return false;
      }

      await tx.circleMember.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', role: 'MEMBER' },
      });
    } else {
      await tx.circleMember.create({
        data: {
          userID: applicantId,
          circleID: circleId,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
    }

    await tx.circle.update({
      where: { id: circleId },
      data: { memberCount: { increment: 1 } },
    });

    return true;
  }

  private async assertCanViewInvitation(
    viewerId: string,
    invitation: Awaited<ReturnType<CircleInvitationService['loadInvitation']>>,
  ): Promise<void> {
    if (
      invitation.applicantID === viewerId ||
      invitation.inviterID === viewerId ||
      invitation.verifiers.some((verifier) => verifier.verifierID === viewerId)
    ) {
      return;
    }

    const membership = await this.prisma.circleMember.findUnique({
      where: {
        userID_circleID: { userID: viewerId, circleID: invitation.circleID },
      },
    });
    if (
      membership &&
      membership.status === 'ACTIVE' &&
      (membership.role === 'OWNER' || membership.role === 'ADMIN')
    ) {
      return;
    }

    throw new ForbiddenException({
      message: 'You are not allowed to view this invitation',
      errorCode: CircleInvitationErrorCode.ViewForbidden,
    });
  }

  private async syncApplicantToGroup(
    groupID: string | null | undefined,
    applicantId: string | undefined,
  ): Promise<void> {
    if (!groupID || !applicantId) {
      return;
    }

    try {
      await this.openimService.addGroupMembers(groupID, [applicantId]);
    } catch (error) {
      this.logger.warn(
        `Failed to add user ${applicantId} to OpenIM group ${groupID}: ${error}`,
      );
    }
  }

  private async createAndBroadcastInvitationNotification(
    data: CircleInvitationNotificationData,
  ): Promise<void> {
    try {
      const notification =
        await this.notificationService.createCircleInvitationNotification(data);
      if (!notification) return;
      await this.realtimeService.broadcastInteractionUnread(data.toUserID);
      this.realtimeService.broadcastNotificationCreated(
        data.toUserID,
        notification,
      );
    } catch (error) {
      this.logger.warn(
        `Circle invitation notification side effect failed: ${data.type} ${data.fromUserID} -> ${data.toUserID}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async runInvitationTransaction<T>(
    operation: (tx: any) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_INVITATION_TX_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          this.isRetryableTransactionError(error) &&
          attempt < MAX_INVITATION_TX_ATTEMPTS
        ) {
          this.logger.warn(
            `Retrying invitation transaction after serialization conflict (attempt ${attempt})`,
          );
          continue;
        }
        throw error;
      }
    }

    throw new Error('Unreachable invitation transaction state');
  }

  private isRetryableTransactionError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }

  private async areFriends(a: string, b: string): Promise<boolean> {
    const record = await this.prisma.friend.findFirst({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: a, friendID: b },
          { userID: b, friendID: a },
        ],
      },
      select: { userID: true },
    });
    return record !== null;
  }
}
