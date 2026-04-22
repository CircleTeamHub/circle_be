import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenimService } from 'src/openim/openim.service';
import {
  InvitationDto,
  InvitationVerifierDto,
} from './dto/circle-invitation.dto';

const MAX_INVITATION_TX_ATTEMPTS = 3;

@Injectable()
export class CircleInvitationService {
  private readonly logger = new Logger(CircleInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
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
      throw new ForbiddenException(
        'You must be an active member to invite others',
      );
    }

    // 2. Verify applicant is NOT already a member
    const applicantMembership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: applicantId, circleID: circleId } },
    });
    if (applicantMembership?.status === 'ACTIVE') {
      throw new ConflictException('User is already a member of this circle');
    }

    // 3. Verify no existing PENDING invitation
    const existingInvitation = await this.prisma.circleInvitation.findFirst({
      where: {
        circleID: circleId,
        applicantID: applicantId,
        status: 'PENDING',
      },
    });
    if (existingInvitation) {
      throw new ConflictException(
        'There is already a pending invitation for this user',
      );
    }

    // 4. Verify circle capacity
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, deleted: false },
    });
    if (!circle) throw new NotFoundException('Circle not found');
    if (circle.maxMembers != null && circle.memberCount >= circle.maxMembers) {
      throw new BadRequestException('Circle has reached its member limit');
    }

    // 5. Verify applicant meets join restrictions
    const applicant = await this.prisma.user.findUnique({
      where: { id: applicantId },
      select: { vipLevel: true, creditScore: true, fancyNumber: true },
    });
    if (!applicant) throw new NotFoundException('User not found');

    if (
      circle.joinVipRestriction != null &&
      applicant.vipLevel < circle.joinVipRestriction
    ) {
      throw new ForbiddenException(
        `Applicant needs VIP ${circle.joinVipRestriction}+ to join`,
      );
    }
    if (
      circle.joinCreditRestriction != null &&
      applicant.creditScore < circle.joinCreditRestriction
    ) {
      throw new ForbiddenException(
        `Applicant needs credit score ${circle.joinCreditRestriction}+ to join`,
      );
    }
    if (circle.joinFancyRestriction && !applicant.fancyNumber) {
      throw new ForbiddenException('Applicant needs a fancy number to join');
    }

    // 6. Create invitation + auto-approve inviter as first verifier
    const invitation = await this.prisma.$transaction(async (tx) => {
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
    await this.runInvitationTransaction(async (tx) => {
      const invitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { verifiers: true },
      });
      if (!invitation) throw new NotFoundException('Invitation not found');

      // Only the applicant can add verifiers
      if (invitation.applicantID !== callerId) {
        throw new ForbiddenException('Only the applicant can add verifiers');
      }
      if (invitation.status !== 'PENDING') {
        throw new BadRequestException('Invitation is no longer pending');
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
        throw new BadRequestException('该好友不在本圈子，请更换验证人再尝试');
      }

      const existingVerifier = invitation.verifiers.find(
        (verifier) => verifier.verifierID === verifierId,
      );
      if (existingVerifier) {
        throw new ConflictException('This user is already a verifier');
      }

      const activeSlots = invitation.verifiers.filter(
        (verifier) => verifier.status !== 'REJECTED',
      ).length;
      if (activeSlots >= invitation.requiredCount) {
        throw new BadRequestException('All verification slots are filled');
      }

      await tx.circleInvitationVerifier.create({
        data: {
          invitationID: invitationId,
          verifierID: verifierId,
          addedByID: callerId,
          status: 'PENDING',
        },
      });

      // Create activity notification for the verifier
      await tx.circleActivity.create({
        data: {
          circleID: invitation.circleID,
          invitationID: invitationId,
          viewerID: verifierId,
          actorID: callerId,
          type: 'VERIFICATION_REQUESTED',
        },
      });
    });
  }

  async respond(
    verifierId: string,
    invitationId: string,
    approve: boolean,
  ): Promise<void> {
    const admission = await this.runInvitationTransaction(async (tx) => {
      const verifierRecord = await tx.circleInvitationVerifier.findFirst({
        where: {
          invitationID: invitationId,
          verifierID: verifierId,
          status: 'PENDING',
        },
      });
      if (!verifierRecord) {
        throw new NotFoundException('No pending verification found for you');
      }

      const invitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { circle: true },
      });
      if (!invitation || invitation.status !== 'PENDING') {
        throw new BadRequestException('Invitation is no longer pending');
      }

      await tx.circleInvitationVerifier.update({
        where: { id: verifierRecord.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          respondedAt: new Date(),
        },
      });

      if (!approve) {
        await tx.circleActivity.create({
          data: {
            circleID: invitation.circleID,
            invitationID: invitationId,
            viewerID: invitation.applicantID,
            actorID: verifierId,
            type: 'INVITATION_SLOT_REJECTED',
          },
        });
        return null;
      }

      const updatedRows = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { approvedCount: { increment: 1 } },
      });
      if (updatedRows.count === 0) {
        throw new BadRequestException('Invitation is no longer pending');
      }

      const updatedInvitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { circle: true },
      });
      if (!updatedInvitation) {
        throw new NotFoundException('Invitation not found');
      }

      if (updatedInvitation.approvedCount < updatedInvitation.requiredCount) {
        return null;
      }

      const finalized = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'APPROVED' },
      });
      if (finalized.count === 0) {
        return null;
      }

      const admitted = await this.admitApplicant(
        tx,
        updatedInvitation.circleID,
        updatedInvitation.applicantID,
      );

      await tx.circleActivity.create({
        data: {
          circleID: updatedInvitation.circleID,
          invitationID: invitationId,
          viewerID: updatedInvitation.applicantID,
          actorID: verifierId,
          type: 'INVITATION_ALL_APPROVED',
        },
      });

      return admitted
        ? {
            applicantId: updatedInvitation.applicantID,
            groupID: updatedInvitation.circle.groupID,
          }
        : null;
    });

    await this.syncApplicantToGroup(
      admission?.groupID ?? null,
      admission?.applicantId,
    );
  }

  async adminApprove(adminId: string, invitationId: string): Promise<void> {
    const invitation = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      select: { circleID: true },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');

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
      throw new ForbiddenException('Only circle owner or admin can override');
    }

    const admission = await this.runInvitationTransaction(async (tx) => {
      const pendingInvitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { circle: true },
      });
      if (!pendingInvitation) {
        throw new NotFoundException('Invitation not found');
      }
      if (pendingInvitation.status !== 'PENDING') {
        throw new BadRequestException('Invitation is no longer pending');
      }

      const finalized = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'ADMIN_APPROVED' },
      });
      if (finalized.count === 0) {
        return null;
      }

      const admitted = await this.admitApplicant(
        tx,
        pendingInvitation.circleID,
        pendingInvitation.applicantID,
      );

      await tx.circleActivity.create({
        data: {
          circleID: pendingInvitation.circleID,
          invitationID: invitationId,
          viewerID: pendingInvitation.applicantID,
          actorID: adminId,
          type: 'ADMIN_OVERRIDE_APPROVED',
        },
      });

      return admitted
        ? {
            applicantId: pendingInvitation.applicantID,
            groupID: pendingInvitation.circle.groupID,
          }
        : null;
    });

    await this.syncApplicantToGroup(
      admission?.groupID ?? null,
      admission?.applicantId,
    );
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
    const pending = await this.prisma.circleInvitationVerifier.findMany({
      where: { verifierID: userId, status: 'PENDING' },
      select: { invitationID: true },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      pending.map((record) => this.fetchInvitationDto(record.invitationID)),
    );
  }

  async getMyApplications(userId: string): Promise<InvitationDto[]> {
    const invitations = await this.prisma.circleInvitation.findMany({
      where: { applicantID: userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return Promise.all(
      invitations.map((invitation) => this.fetchInvitationDto(invitation.id)),
    );
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
      throw new ForbiddenException('Only circle owner or admin can view');
    }

    const invitations = await this.prisma.circleInvitation.findMany({
      where: { circleID: circleId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return Promise.all(
      invitations.map((invitation) => this.fetchInvitationDto(invitation.id)),
    );
  }

  private async loadInvitation(invitationId: string) {
    const inv = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      include: {
        circle: true,
        applicant: true,
        inviter: true,
        verifiers: {
          include: { verifier: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!inv) throw new NotFoundException('Invitation not found');
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
      throw new NotFoundException('Circle not found');
    }

    const needsSeat = !existing || existing.status !== 'ACTIVE';
    if (
      needsSeat &&
      circle.maxMembers != null &&
      circle.memberCount >= circle.maxMembers
    ) {
      throw new BadRequestException('Circle has reached its member limit');
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

    throw new ForbiddenException('You are not allowed to view this invitation');
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
}
