import { Injectable, NotFoundException } from '@nestjs/common';
import { MembershipBenefitType } from 'src/generated/prisma';
import { MembershipErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MembershipPlanDto,
  MembershipQuotasDto,
  MembershipStatusDto,
} from './dto/membership.dto';
import { MembershipPolicyService } from './membership-policy.service';
import {
  MEMBERSHIP_CATALOG,
  MembershipTier,
  StoredMembership,
} from './membership.catalog';

function mapQuotas(tier: MembershipTier): MembershipQuotasDto {
  return {
    groupMembers: { ...tier.quotas.groupMembers },
    joinedCircles: { ...tier.quotas.joinedCircles },
    createdCircles: { ...tier.quotas.createdCircles },
    notes: { ...tier.quotas.notes },
    cityFilters: { ...tier.quotas.cityFilters },
  };
}

export function mapMembershipStatus(
  membership: StoredMembership,
  tier: MembershipTier,
  effectiveLevel: number,
  issuedBenefitTypes: readonly MembershipBenefitType[],
): MembershipStatusDto {
  const standardIssued = issuedBenefitTypes.includes(
    MembershipBenefitType.STANDARD_FANCY_NUMBER,
  );
  const premiumIssued = issuedBenefitTypes.includes(
    MembershipBenefitType.PREMIUM_FANCY_NUMBER,
  );

  return {
    storedLevel: membership.vipLevel,
    effectiveLevel,
    key: tier.key,
    vipExpiresAt: membership.vipExpiresAt,
    lifetime: tier.lifetime,
    active: effectiveLevel > 0,
    quotas: mapQuotas(tier),
    appearance: { ...tier.appearance },
    benefits: { ...tier.benefits },
    benefitGrants: {
      standardFancyNumber: {
        available:
          tier.benefits.fancyNumberVoucher === 'standard' && !standardIssued,
        issued: standardIssued,
      },
      premiumFancyNumber: {
        available:
          tier.benefits.fancyNumberVoucher === 'premium' && !premiumIssued,
        issued: premiumIssued,
      },
    },
  };
}

@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membershipPolicy: MembershipPolicyService,
  ) {}

  getPlans(): MembershipPlanDto[] {
    return MEMBERSHIP_CATALOG.slice(1).map((tier) => ({
      level: tier.level,
      key: tier.key as MembershipPlanDto['key'],
      durationMonths: tier.durationMonths,
      lifetime: tier.lifetime,
      priceCny: tier.priceCny,
      recommended: tier.recommended,
      quotas: mapQuotas(tier),
      appearance: { ...tier.appearance },
      benefits: { ...tier.benefits },
    }));
  }

  async getMe(userId: string, now = new Date()): Promise<MembershipStatusDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        vipLevel: true,
        vipExpiresAt: true,
        membershipBenefitGrants: { select: { type: true } },
      },
    });
    if (!user) {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: MembershipErrorCode.UserNotFound,
      });
    }

    const effective = this.membershipPolicy.resolve(user, now);
    return mapMembershipStatus(
      user,
      effective.tier,
      effective.level,
      user.membershipBenefitGrants.map((grant) => grant.type),
    );
  }
}
