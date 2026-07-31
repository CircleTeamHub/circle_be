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
import { CircleErrorCode } from 'src/common/app-error-codes';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipLevel } from 'src/membership/membership.catalog';
import { reserveCircleSeats } from './circle-capacity';
import { CIRCLE_JOIN_LIMIT } from './circle-limits';
import { CircleMemberLockService } from './circle-member-lock';
import { resolveEffectiveFancyNumber } from 'src/fancy-number/fancy-number-status';

type JoinLimitAudience = {
  /**
   * 加入上限被触发时，这个错误最终会被谁读到 —— 决定回哪个错误码：
   * - `self`：被限制的用户本人（自助申请加入），可以直接告知自己的上限数值；
   * - `third-party`：邀请人或审批人。受限的是别人，所以既不能带 limit /
   *   quota / details（他人的额度状态不外泄），客户端也需要一句写给操作者
   *   而不是写给申请人的文案。
   */
  actor?: 'self' | 'third-party';
};

type AdmissionOptions = JoinLimitAudience & {
  locksHeld?: boolean;
};

const CIRCLE_ADMISSION_SELECT = {
  id: true,
  deleted: true,
  ownerID: true,
  maxMembers: true,
  expansionSeats: true,
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
    if (activatingUserIDs.length === 0) {
      await this.cancelPendingInvitations(tx, circleID, userIDs);
      return [];
    }

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
        fancyNumberExpiresAt: true,
        fancyNumberPermanent: true,
      },
    });
    const userByID = new Map(
      users.map((candidate) => [candidate.id, candidate]),
    );
    const now = new Date();

    // The join limit applies only to ACTIVE non-owner memberships. Owned
    // circles are governed by creation policy and never consume this limit.
    const joinedCounts = await tx.circleMember.groupBy({
      by: ['userID'],
      where: {
        userID: { in: activatingUserIDs },
        role: { not: CircleMemberRole.OWNER },
        status: CircleMemberStatus.ACTIVE,
      },
      _count: { _all: true },
    });
    const joinedCountByUserID = new Map(
      joinedCounts.map((row) => [row.userID, row._count._all]),
    );

    // staged-rollout 状态在循环外读一次；每个候选人再各查一次会在持有全部 advisory 锁的
    // Serializable 事务里串行往返（最多 100 次），徒增延迟与锁竞争。
    // lockForWrite: serialize the rollout-floor read against program enablement
    // so quota decisions below cannot commit under an obsolete entitlement floor.
    const program = await this.membershipPolicy.loadProgramStatus(tx, {
      lockForWrite: true,
    });

    for (const userID of activatingUserIDs) {
      const candidate = userByID.get(userID);
      if (!candidate) this.throwCandidateNotFound();

      const effective = this.membershipPolicy.resolveEntitlementWith(
        candidate,
        program,
        now,
      );
      if ((joinedCountByUserID.get(userID) ?? 0) >= CIRCLE_JOIN_LIMIT) {
        // 所有调用点（审批通过、管理员放行、圈内邀请入群）里被激活的都是别人，
        // 错误回给操作者，所以默认之外的 actor 必须由调用方显式声明。
        this.throwJoinLimitReached(options.actor ?? 'self');
      }
      this.assertRestrictions(
        circle,
        {
          ...candidate,
          fancyNumber: resolveEffectiveFancyNumber(candidate, now),
        },
        effective.level,
      );
    }

    // 圈主软降级：座位数还要受圈主「当前有效会员」的单群人数配额限（不只受 maxMembers）。否则
    // 钻石圈主建 1000 人群后过期降级仍能继续加到 1000，legacy null maxMembers 更是无限，违背软
    // 降级（保留存量、按低配额挡新增）。owner 理论必然存在，缺失时按普通用户兜底、不放宽。
    const owner = await tx.user.findUnique({
      where: { id: circle.ownerID },
      select: { vipLevel: true, vipExpiresAt: true },
    });
    const ownerMembershipCapacity =
      this.membershipPolicy.resolveEntitlementWith(
        owner ?? { vipLevel: 0, vipExpiresAt: null },
        program,
        now,
      ).tier.quotas.groupMembers.actual;
    const ownerCapacity = Math.min(
      3000,
      ownerMembershipCapacity + circle.expansionSeats,
    );

    const reserved = await reserveCircleSeats(
      tx,
      circleID,
      activatingUserIDs.length,
      ownerCapacity,
    );
    if (!reserved) {
      const currentCircle = await tx.circle.findUnique({
        where: { id: circleID },
        select: { deleted: true, maxMembers: true },
      });
      if (!currentCircle || currentCircle.deleted) this.throwCircleNotFound();
      // Report the bound that actually rejected: seats are capped by BOTH the
      // stored maxMembers and the owner's current groupMembers quota. A
      // downgraded owner (ownerCapacity < maxMembers) or a legacy null-cap
      // circle rejects at ownerCapacity, so surface the effective minimum
      // instead of the stored value — never a misleading larger or null limit.
      const effectiveLimit = Math.min(
        currentCircle.maxMembers ?? ownerCapacity,
        ownerCapacity,
      );
      throw new BadRequestException({
        message: 'Circle has reached its member limit',
        errorCode: CircleErrorCode.MemberLimit,
        limit: effectiveLimit,
        details: { limit: effectiveLimit },
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

    await this.cancelPendingInvitations(tx, circleID, userIDs);

    return activatingUserIDs;
  }

  private async cancelPendingInvitations(
    tx: Prisma.TransactionClient,
    circleID: string,
    userIDs: readonly string[],
  ): Promise<void> {
    await tx.circleInvitation.updateMany({
      where: {
        circleID,
        applicantID: { in: [...userIDs] },
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
  }

  async assertCanApply(
    tx: Prisma.TransactionClient,
    circleID: string,
    userID: string,
    { actor = 'self' }: JoinLimitAudience = {},
  ): Promise<void> {
    const circle = await tx.circle.findFirst({
      where: { id: circleID, deleted: false },
      select: CIRCLE_ADMISSION_SELECT,
    });
    if (!circle) this.throwCircleNotFound();

    const joinedCount = await tx.circleMember.count({
      where: {
        userID,
        role: { not: CircleMemberRole.OWNER },
        status: CircleMemberStatus.ACTIVE,
      },
    });
    if (joinedCount >= CIRCLE_JOIN_LIMIT) {
      this.throwJoinLimitReached(actor);
    }

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
        fancyNumberExpiresAt: true,
        fancyNumberPermanent: true,
      },
    });
    if (!candidate) this.throwCandidateNotFound();
    const now = new Date();
    const effective = await this.membershipPolicy.resolveEntitlement(
      candidate,
      tx,
      now,
      { lockForWrite: true },
    );
    this.assertRestrictions(
      circle,
      {
        ...candidate,
        fancyNumber: resolveEffectiveFancyNumber(candidate, now),
      },
      effective.level,
    );
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

  /**
   * 加入上限的唯一抛出点。两条写路径（申请、激活）共用，保证同一条规则不会
   * 因为调用方不同而给出两套字段。
   */
  private throwJoinLimitReached(actor: 'self' | 'third-party'): never {
    // 邀请 / 审批路径下受限的是别人：不能带 limit / quota / details，也不能复用
    // INVITATION_NOT_ALLOWED —— 那个码的既有语义是「对方隐私设置不接受邀请」
    // (circle-invitation.service.ts)，客户端文案是「对方不接受圈子邀请」，
    // 拿它表达配额会让操作者读到一句与事实不符、也无从处理的提示。
    if (actor === 'third-party') {
      throw new ForbiddenException({
        message: 'Target user has reached the joined circle limit',
        errorCode: CircleErrorCode.TargetJoinLimitReached,
      });
    }
    throw new ForbiddenException({
      message: 'Joined circle membership quota reached',
      errorCode: CircleErrorCode.JoinLimitReached,
      quota: 'joined-circles',
      limit: CIRCLE_JOIN_LIMIT,
      details: {
        quota: 'joined-circles',
        limit: CIRCLE_JOIN_LIMIT,
      },
    });
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
