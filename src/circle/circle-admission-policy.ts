import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CircleMemberRole,
  CircleMemberStatus,
  Prisma,
} from 'src/generated/prisma';
import {
  CircleErrorCode,
  MembershipErrorCode,
} from 'src/common/app-error-codes';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipLevel } from 'src/membership/membership.catalog';
import { reserveCircleSeats } from './circle-capacity';
import { CircleMemberLockService } from './circle-member-lock';

type AdmissionOptions = {
  locksHeld?: boolean;
};

const CIRCLE_ADMISSION_SELECT = {
  id: true,
  deleted: true,
  maxMembers: true,
  memberCount: true,
  joinVipRestriction: true,
  joinCreditRestriction: true,
  joinFancyRestriction: true,
} as const;

@Injectable()
export class CircleAdmissionPolicy {
  constructor(
    private readonly membershipPolicy: MembershipPolicyService,
    private readonly memberLock: CircleMemberLockService,
  ) {}

  async activateMembers(
    tx: Prisma.TransactionClient,
    circleID: string,
    requestedUserIDs: readonly string[],
    options: AdmissionOptions = {},
  ): Promise<string[]> {
    const userIDs = this.uniqueSortedIDs(requestedUserIDs);
    if (userIDs.length === 0) return [];

    // Global user locks always precede pair and circle locks. This serializes a
    // user's admissions across different circles without creating lock cycles.
    if (!options.locksHeld) {
      await this.memberLock.lock(tx, circleID, userIDs);
    }

    const memberships = await tx.circleMember.findMany({
      where: { circleID, userID: { in: userIDs } },
      select: { id: true, userID: true, status: true },
    });
    const membershipByUserID = new Map(
      memberships.map((membership) => [membership.userID, membership]),
    );
    const activatingUserIDs = userIDs.filter(
      (userID) =>
        membershipByUserID.get(userID)?.status !== CircleMemberStatus.ACTIVE,
    );

    // Existing ACTIVE rows stay idempotent after a downgrade or restriction
    // change. Quotas only gate new activations; they never remove memberships.
    if (activatingUserIDs.length === 0) return [];

    const circle = await tx.circle.findUnique({
      where: { id: circleID },
      select: CIRCLE_ADMISSION_SELECT,
    });
    if (!circle || circle.deleted) this.throwCircleNotFound();

    const users = await tx.user.findMany({
      where: { id: { in: activatingUserIDs } },
      select: {
        id: true,
        vipLevel: true,
        vipExpiresAt: true,
        creditScore: true,
        fancyNumber: true,
      },
    });
    const userByID = new Map(
      users.map((candidate) => [candidate.id, candidate]),
    );
    const now = new Date();

    const counts = await Promise.all(
      activatingUserIDs.map((userID) =>
        tx.circleMember.count({
          where: {
            userID,
            status: CircleMemberStatus.ACTIVE,
            role: { not: CircleMemberRole.OWNER },
          },
        }),
      ),
    );

    for (const [index, userID] of activatingUserIDs.entries()) {
      const candidate = userByID.get(userID);
      if (!candidate) this.throwCandidateNotFound();

      const effective = this.membershipPolicy.resolve(candidate, now);
      const limit = effective.tier.quotas.joinedCircles.actual;
      if (counts[index] >= limit) {
        throw new ForbiddenException({
          message: 'Joined circle membership quota reached',
          errorCode: MembershipErrorCode.JoinedCircleQuotaReached,
          quota: 'joined-circles',
          limit,
          details: { quota: 'joined-circles', limit },
        });
      }
      this.assertRestrictions(circle, candidate, effective.level);
    }

    const reserved = await reserveCircleSeats(
      tx,
      circleID,
      activatingUserIDs.length,
    );
    if (!reserved) {
      const currentCircle = await tx.circle.findUnique({
        where: { id: circleID },
        select: { deleted: true, maxMembers: true },
      });
      if (!currentCircle || currentCircle.deleted) this.throwCircleNotFound();
      throw new BadRequestException({
        message: 'Circle has reached its member limit',
        errorCode: CircleErrorCode.MemberLimit,
        limit: currentCircle.maxMembers,
        details: { limit: currentCircle.maxMembers },
      });
    }

    const reactivatingIDs = activatingUserIDs
      .map((userID) => membershipByUserID.get(userID)?.id)
      .filter((id): id is string => id !== undefined);
    if (reactivatingIDs.length > 0) {
      await tx.circleMember.updateMany({
        where: {
          id: { in: reactivatingIDs },
          status: { not: CircleMemberStatus.ACTIVE },
        },
        data: {
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.ACTIVE,
        },
      });
    }

    const newUserIDs = activatingUserIDs.filter(
      (userID) => !membershipByUserID.has(userID),
    );
    if (newUserIDs.length > 0) {
      await tx.circleMember.createMany({
        data: newUserIDs.map((userID) => ({
          userID,
          circleID,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.ACTIVE,
        })),
      });
    }

    return activatingUserIDs;
  }

  async assertCanApply(
    tx: Prisma.TransactionClient,
    circleID: string,
    userID: string,
  ): Promise<void> {
    const circle = await tx.circle.findFirst({
      where: { id: circleID, deleted: false },
      select: CIRCLE_ADMISSION_SELECT,
    });
    if (!circle) this.throwCircleNotFound();
    if (circle.maxMembers != null && circle.memberCount >= circle.maxMembers) {
      throw new BadRequestException({
        message: 'Circle has reached its member limit',
        errorCode: CircleErrorCode.MemberLimit,
        limit: circle.maxMembers,
        details: { limit: circle.maxMembers },
      });
    }

    const candidate = await tx.user.findUnique({
      where: { id: userID },
      select: {
        vipLevel: true,
        vipExpiresAt: true,
        creditScore: true,
        fancyNumber: true,
      },
    });
    if (!candidate) this.throwCandidateNotFound();
    const effective = this.membershipPolicy.resolve(candidate, new Date());
    this.assertRestrictions(circle, candidate, effective.level);
  }

  normalizeCreatorVipRestriction(
    requested: number | null | undefined,
    creatorLevel: MembershipLevel,
  ): number | null {
    if (requested == null || requested === 0) return null;
    if (requested > creatorLevel) {
      throw new ForbiddenException({
        message: 'Circle VIP restriction exceeds creator membership',
        errorCode: CircleErrorCode.JoinVipRestrictionExceedsCreator,
        limit: creatorLevel,
        details: { limit: creatorLevel },
      });
    }
    return requested;
  }

  private assertRestrictions(
    circle: {
      joinVipRestriction: number | null;
      joinCreditRestriction: number | null;
      joinFancyRestriction: boolean;
    },
    candidate: { creditScore: number; fancyNumber: boolean },
    effectiveLevel: MembershipLevel,
  ): void {
    if (
      circle.joinVipRestriction != null &&
      effectiveLevel < circle.joinVipRestriction
    ) {
      throw new ForbiddenException({
        message: `VIP ${circle.joinVipRestriction}+ is required to join this circle`,
        errorCode: CircleErrorCode.JoinVipRequired,
      });
    }
    if (
      circle.joinCreditRestriction != null &&
      candidate.creditScore < circle.joinCreditRestriction
    ) {
      throw new ForbiddenException({
        message: `Credit score ${circle.joinCreditRestriction}+ is required to join this circle`,
        errorCode: CircleErrorCode.JoinCreditRequired,
      });
    }
    if (circle.joinFancyRestriction && !candidate.fancyNumber) {
      throw new ForbiddenException({
        message: 'A fancy number is required to join this circle',
        errorCode: CircleErrorCode.JoinFancyNumberRequired,
      });
    }
  }

  private uniqueSortedIDs(userIDs: readonly string[]): string[] {
    // Code-unit ordering matches the global lock service on every host.
    // eslint-disable-next-line sonarjs/no-alphabetical-sort
    return [...new Set(userIDs)].sort();
  }

  private throwCircleNotFound(): never {
    throw new NotFoundException({
      message: 'Circle not found',
      errorCode: CircleErrorCode.NotFound,
    });
  }

  private throwCandidateNotFound(): never {
    throw new NotFoundException({
      message: 'User not found',
      errorCode: CircleErrorCode.UserNotFound,
    });
  }
}
