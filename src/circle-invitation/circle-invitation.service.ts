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
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { NotificationService } from 'src/notification/notification.service';
import { feedCursorWhere } from 'src/utils/feed-cursor';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  DEFAULT_INVITATION_LIST_LIMIT,
  InvitationDto,
  InvitationListQueryDto,
  InvitationVerifierDto,
} from './dto/circle-invitation.dto';

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
// list endpoints can hydrate in one round-trip instead of N+1. Narrowed to the
// columns toInvitationDto and assertCanViewInvitation read — `true` here would
// pull every column of the circle and of each of the ~12 joined users.
const INVITATION_USER_SELECT = {
  id: true,
  nickname: true,
  avatarUrl: true,
  accountId: true,
} as const;

const INVITATION_INCLUDE = {
  circle: { select: { name: true } },
  applicant: { select: INVITATION_USER_SELECT },
  inviter: { select: INVITATION_USER_SELECT },
  verifiers: {
    select: {
      id: true,
      verifierID: true,
      status: true,
      respondedAt: true,
      verifier: { select: INVITATION_USER_SELECT },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

@Injectable()
export class CircleInvitationService {
  private readonly logger = new Logger(CircleInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly privacySettings: PrivacySettingsService,
    private readonly notificationService: NotificationService,
    private readonly admissionPolicy: CircleAdmissionPolicy,
    private readonly memberLock: CircleMemberLockService,
    private readonly chatCircleSync: ChatCircleSyncService,
  ) {}

  /**
   * 激活提交后立刻触发一次幂等座位同步,新成员不必等 ≤1min 的对账才拿到
   * 会话与消息。失败只记日志:每分钟对账本来就是这条路径的兜底。
   */
  private syncCircleSeatsSoon(circleID: string): void {
    void this.chatCircleSync
      .ensureCircleConversation(circleID)
      .catch((error) =>
        this.logger.warn(
          `post-admission seat sync failed circle=${circleID}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }

  async invite(
    inviterId: string,
    applicantId: string,
    circleId: string,
  ): Promise<InvitationDto> {
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
    const invitation = await this.runInvitationTransaction(async (tx) => {
      // CircleInvitation has no DB-level unique constraint, so serialize
      // concurrent invites for the same (circle, applicant) pair with a
      // transaction-scoped advisory lock, then re-check inside the lock.
      await this.memberLock.lock(tx, circleId, [inviterId, applicantId]);

      const [inviterMembership, lockedMembership] = await Promise.all([
        tx.circleMember.findUnique({
          where: {
            userID_circleID: { userID: inviterId, circleID: circleId },
          },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: { userID: applicantId, circleID: circleId },
          },
        }),
      ]);
      if (!inviterMembership || inviterMembership.status !== 'ACTIVE') {
        throw new ForbiddenException({
          message: 'You must be an active member to invite others',
          errorCode: CircleInvitationErrorCode.InviterNotMember,
        });
      }
      if (lockedMembership?.status === 'ACTIVE') {
        throw new ConflictException({
          message: 'User is already a member of this circle',
          errorCode: CircleErrorCode.AlreadyMember,
        });
      }
      // applicantId 是被邀请人，任何拒绝原因都会回给 inviter —— 用第三方视角
      // 调用，避免把对方的加入额度状态泄露给邀请人。
      await this.admissionPolicy.assertCanApply(tx, circleId, applicantId, {
        actor: 'third-party',
      });

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
      await this.memberLock.lock(tx, application.circleID, [
        callerId,
        verifierId,
      ]);

      const [invitation, membership] = await Promise.all([
        tx.circleInvitation.findUnique({
          where: { id: invitationId },
          include: { verifiers: true },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: {
              userID: verifierId,
              circleID: application.circleID,
            },
          },
        }),
      ]);
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
      await this.memberLock.lock(tx, application.circleID, [
        verifierId,
        application.applicantID,
      ]);

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

      // Leaving or being removed from the circle deletes the membership but
      // leaves the verifier row behind, so eligibility is re-checked at vote
      // time rather than trusting the check made when the slot was assigned.
      const verifierMembership = await tx.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: verifierId,
            circleID: invitation.circleID,
          },
        },
      });
      if (!verifierMembership || verifierMembership.status !== 'ACTIVE') {
        throw new ForbiddenException({
          message: '验证人必须是本圈子的活跃成员',
          errorCode: CircleInvitationErrorCode.VerifierNotMember,
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

      // 审批人（担保成员）读到的错误说的是申请人的额度，不是自己的。
      const admitted = await this.admissionPolicy.activateMembers(
        tx,
        updatedInvitation.circleID,
        [updatedInvitation.applicantID],
        { locksHeld: true, actor: 'third-party' },
      );

      return {
        admission:
          admitted.length > 0
            ? {
                applicantId: updatedInvitation.applicantID,
                circleID: updatedInvitation.circleID,
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

    if (result.admission) {
      this.syncCircleSeatsSoon(result.admission.circleID);
    }

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
      await this.memberLock.lock(tx, application.circleID, [
        adminId,
        application.applicantID,
      ]);

      const [pendingInvitation, membership] = await Promise.all([
        tx.circleInvitation.findUnique({
          where: { id: invitationId },
          include: { circle: true },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: {
              userID: adminId,
              circleID: application.circleID,
            },
          },
        }),
      ]);
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

      const finalized = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'ADMIN_APPROVED' },
      });
      if (finalized.count === 0) {
        return { admission: null, notificationData: null };
      }

      // 同上：圈主 / 管理员强制通过，错误回给操作者而不是申请人。
      const admitted = await this.admissionPolicy.activateMembers(
        tx,
        pendingInvitation.circleID,
        [pendingInvitation.applicantID],
        { locksHeld: true, actor: 'third-party' },
      );

      return {
        admission:
          admitted.length > 0
            ? {
                applicantId: pendingInvitation.applicantID,
                circleID: pendingInvitation.circleID,
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

    if (result.admission) {
      this.syncCircleSeatsSoon(result.admission.circleID);
    }

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
          await this.memberLock.lock(tx, candidate.circleID, [
            candidate.applicantID,
          ]);

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
          // 后台补偿任务：异常只进日志、没有接收方，保留默认的详细错误码，
          // 这样 catch 里记下的是「哪条上限挡住了」而不是一句中性话。
          const admitted = await this.admissionPolicy.activateMembers(
            tx,
            invitation.circleID,
            [invitation.applicantID],
            { locksHeld: true },
          );
          return {
            admitted: admitted.length > 0,
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
        if (result.admitted) {
          this.syncCircleSeatsSoon(result.circleId);
        }
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
        // Transient conflicts are already retried inside the transaction, so
        // reaching here means a deterministic block (full circle / unmet
        // restriction / missing side-effect). Left untouched, such rows keep
        // the oldest `updatedAt` and re-fill the `ORDER BY updatedAt ASC LIMIT
        // 100` window every run, starving admissible invitations. Touch the row
        // so it rotates to the back of the queue; a still-blocked candidate
        // simply retries on a later cycle instead of monopolizing the batch.
        try {
          await this.prisma.circleInvitation.updateMany({
            where: { id: candidate.id, status: 'PENDING' },
            data: { status: 'PENDING' },
          });
        } catch (bumpError) {
          this.logger.warn(
            `Failed to defer reconciliation row ${candidate.id}: ${
              bumpError instanceof Error ? bumpError.message : String(bumpError)
            }`,
          );
        }
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

  async getMyPendingVerifications(
    userId: string,
    query: InvitationListQueryDto = new InvitationListQueryDto(),
  ): Promise<InvitationDto[]> {
    const whereBase: Prisma.CircleInvitationWhereInput = {
      status: 'PENDING',
      verifiers: { some: { verifierID: userId, status: 'PENDING' } },
    };
    const cursorWhere = await this.pendingInvitationCursorWhere(query.cursor, {
      verifiers: { some: { verifierID: userId } },
    });
    // Single hydrated query — no N+1 over individual invitation loads.
    const invitations = await this.prisma.circleInvitation.findMany({
      where: cursorWhere ? { AND: [whereBase, cursorWhere] } : whereBase,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INVITATION_INCLUDE,
      take: query.limit ?? DEFAULT_INVITATION_LIST_LIMIT,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  async getMyApplications(
    userId: string,
    query: InvitationListQueryDto = new InvitationListQueryDto(),
  ): Promise<InvitationDto[]> {
    const whereBase: Prisma.CircleInvitationWhereInput = {
      applicantID: userId,
      status: 'PENDING',
    };
    const cursorWhere = await this.pendingInvitationCursorWhere(query.cursor, {
      applicantID: userId,
    });
    const invitations = await this.prisma.circleInvitation.findMany({
      // Settled applications are history the caller cannot act on; only the
      // in-flight ones drive the "verify me" entry point.
      where: cursorWhere ? { AND: [whereBase, cursorWhere] } : whereBase,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INVITATION_INCLUDE,
      take: query.limit ?? DEFAULT_INVITATION_LIST_LIMIT,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  async getPendingInvitationsForCircle(
    adminId: string,
    circleId: string,
    query: InvitationListQueryDto = new InvitationListQueryDto(),
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

    const whereBase: Prisma.CircleInvitationWhereInput = {
      circleID: circleId,
      status: 'PENDING',
    };
    const cursorWhere = await this.pendingInvitationCursorWhere(query.cursor, {
      circleID: circleId,
    });
    const invitations = await this.prisma.circleInvitation.findMany({
      where: cursorWhere ? { AND: [whereBase, cursorWhere] } : whereBase,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INVITATION_INCLUDE,
      take: query.limit ?? DEFAULT_INVITATION_LIST_LIMIT,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  private async pendingInvitationCursorWhere(
    cursor: string | undefined,
    scope: Prisma.CircleInvitationWhereInput,
  ): Promise<Prisma.CircleInvitationWhereInput | undefined> {
    if (!cursor) {
      return undefined;
    }

    const anchor = await this.prisma.circleInvitation.findFirst({
      where: { id: cursor, ...scope },
      select: { createdAt: true },
    });
    if (!anchor) {
      throw new BadRequestException({
        message: 'Invalid invitation cursor',
        errorCode: CircleInvitationErrorCode.InvalidCursor,
      });
    }

    return feedCursorWhere({ createdAt: anchor.createdAt, id: cursor });
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
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return runSerializableTransaction(this.prisma, operation);
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
