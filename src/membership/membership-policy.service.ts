import {
  ForbiddenException,
  Injectable,
  NotFoundException,
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

const MEMBERSHIP_USER_LOCK_PREFIX = 'membership-user:';

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
  constructor(private readonly prisma: PrismaService) {}

  resolve(
    membership: StoredMembership,
    now = new Date(),
  ): EffectiveMembershipPolicy {
    const level = resolveEffectiveMembershipLevel(membership, now);
    return {
      level,
      tier: MEMBERSHIP_CATALOG[level],
      vipExpiresAt: membership.vipExpiresAt,
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
    return this.resolve(membership, now);
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
