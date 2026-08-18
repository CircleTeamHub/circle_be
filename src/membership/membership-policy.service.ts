import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { MembershipErrorCode } from 'src/common/app-error-codes';
import {
  MEMBERSHIP_CATALOG,
  MembershipLevel,
  MembershipTier,
  resolveEffectiveMembershipLevel,
  StoredMembership,
} from './membership.catalog';
import {
  MARKETING_ENTITLEMENT_FLOOR_LEVEL,
  MembershipProgramDatabase,
  MembershipProgramService,
  MembershipProgramStatus,
  ProgramReadOptions,
} from './membership-program.service';

const MEMBERSHIP_USER_LOCK_PREFIX = 'membership-user:';

function withoutQuotaCeilings(tier: MembershipTier): MembershipTier {
  return {
    ...tier,
    quotas: {
      groupMembers: {
        ...tier.quotas.groupMembers,
        actual: Number.MAX_SAFE_INTEGER,
      },
      joinedCircles: {
        ...tier.quotas.joinedCircles,
        actual: Number.MAX_SAFE_INTEGER,
      },
      notes: { ...tier.quotas.notes, actual: Number.MAX_SAFE_INTEGER },
      cityFilters: {
        ...tier.quotas.cityFilters,
        actual: Number.MAX_SAFE_INTEGER,
      },
    },
  };
}

const ROLLOUT_DISABLED_TIERS = MEMBERSHIP_CATALOG.map((tier) =>
  withoutQuotaCeilings(tier),
);

export enum MembershipQuota {
  GroupMembers = 'group-members',
  JoinedCircles = 'joined-circles',
  Notes = 'notes',
  CityFilters = 'city-filters',
}

export interface EffectiveMembershipPolicy {
  level: MembershipLevel;
  tier: MembershipTier;
  vipExpiresAt: Date | null;
}

@Injectable()
export class MembershipPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly membershipProgram?: MembershipProgramService,
  ) {}

  resolve(
    membership: StoredMembership,
    now = new Date(),
  ): EffectiveMembershipPolicy {
    const level = resolveEffectiveMembershipLevel(membership, now);
    return {
      level,
      tier: MEMBERSHIP_CATALOG[level],
      vipExpiresAt: membership.vipExpiresAt ?? null,
    };
  }

  async resolveEntitlement(
    membership: StoredMembership,
    db: MembershipProgramDatabase = this.prisma,
    now = new Date(),
    options: ProgramReadOptions = {},
  ): Promise<EffectiveMembershipPolicy> {
    const program = await this.loadProgramStatus(db, options);
    return this.resolveEntitlementWith(membership, program, now);
  }

  /**
   * 载一次 staged-rollout 状态。批量准入（一次可含 100 个目标）用它在循环外读一次，避免每个
   * 候选人各查一次 MembershipProgramState —— 那些串行往返发生在持有全部 advisory 锁的
   * Serializable 事务里，会显著拉长延迟与锁竞争。
   */
  async loadProgramStatus(
    db: MembershipProgramDatabase = this.prisma,
    options: ProgramReadOptions = {},
  ): Promise<MembershipProgramStatus | null> {
    return this.membershipProgram
      ? this.membershipProgram.getStatus(db, options)
      : null;
  }

  /** 用预载的 rollout 状态解析有效权益（无 DB 往返），供批量准入循环用。 */
  resolveEntitlementWith(
    membership: StoredMembership,
    program: MembershipProgramStatus | null,
    now = new Date(),
  ): EffectiveMembershipPolicy {
    const actual = this.resolve(membership, now);
    if (!program) {
      return actual;
    }
    const level = program.enabled
      ? actual.level
      : Math.max(actual.level, MARKETING_ENTITLEMENT_FLOOR_LEVEL);
    const entitlementLevel = level as MembershipLevel;
    return {
      level: entitlementLevel,
      tier: program.enabled
        ? MEMBERSHIP_CATALOG[entitlementLevel]
        : ROLLOUT_DISABLED_TIERS[entitlementLevel],
      vipExpiresAt: actual.vipExpiresAt,
    };
  }

  async getUserPolicy(
    userID: string,
    now = new Date(),
  ): Promise<EffectiveMembershipPolicy> {
    const membership = await this.prisma.user.findUnique({
      where: { id: userID },
      select: { vipLevel: true, vipExpiresAt: true },
    });
    if (!membership) {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: MembershipErrorCode.UserNotFound,
      });
    }
    return this.resolveEntitlement(membership, this.prisma, now);
  }

  async lockUsers(
    tx: Prisma.TransactionClient,
    userIDs: readonly string[],
  ): Promise<void> {
    const keys = [
      ...new Set(userIDs.map((id) => `${MEMBERSHIP_USER_LOCK_PREFIX}${id}`)),
    ]
      // Code-unit ordering is stable across hosts and prevents batch deadlocks.
      // eslint-disable-next-line sonarjs/no-alphabetical-sort
      .sort();
    if (keys.length === 0) {
      return;
    }

    await tx.$executeRaw(
      Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(keys.lock_key, 0))
        FROM unnest(ARRAY[${Prisma.join(keys)}]::text[]) AS keys(lock_key)
      `,
    );
  }

  assertQuotaAvailable(
    quota: MembershipQuota,
    currentCount: number,
    limit: number,
  ): void {
    if (currentCount < limit) {
      return;
    }
    throw new ForbiddenException({
      message: `Membership ${quota.replace(/-/g, ' ')} quota reached`,
      errorCode: 'MEMBERSHIP_QUOTA_REACHED',
      quota,
      limit,
    });
  }
}
