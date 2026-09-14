import { Injectable } from '@nestjs/common';
import { MembershipBenefitType } from 'src/generated/prisma';
import {
  MembershipPlanDto,
  MembershipQuotasDto,
  MembershipStatusDto,
} from './dto/membership.dto';
import {
  MEMBERSHIP_CATALOG,
  MembershipTier,
  StoredMembership,
} from './membership.catalog';

const LEGACY_PLAN_NAMES: Record<MembershipPlanDto['key'], string> = {
  silver: 'Silver',
  gold: 'Gold',
  diamond: 'Diamond',
  super: 'Super',
};
const LEGACY_PLAN_PERKS =
  'See current membership benefits; contact customer service for activation or upgrade support.';

function mapQuotas(tier: MembershipTier): MembershipQuotasDto {
  return {
    groupMembers: { ...tier.quotas.groupMembers },
    joinedCircles: { ...tier.quotas.joinedCircles },
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
  getPlans(): MembershipPlanDto[] {
    return MEMBERSHIP_CATALOG.slice(1).map((tier) => {
      const key = tier.key as MembershipPlanDto['key'];
      return {
        level: tier.level,
        name: LEGACY_PLAN_NAMES[key],
        price: tier.priceCny,
        perks: LEGACY_PLAN_PERKS,
        key,
        durationMonths: tier.durationMonths,
        lifetime: tier.lifetime,
        priceCny: tier.priceCny,
        recommended: tier.recommended,
        quotas: mapQuotas(tier),
        appearance: { ...tier.appearance },
        benefits: { ...tier.benefits },
      };
    });
  }
}
