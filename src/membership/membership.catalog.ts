export type MembershipLevel = 0 | 1 | 2 | 3 | 4;
export type MembershipTierKey =
  | 'regular'
  | 'silver'
  | 'gold'
  | 'diamond'
  | 'super';
export type MembershipQuotaDisplay =
  | `${number}`
  | 'cannot-create'
  | '999+'
  | 'unlimited';
export type MembershipNameColor =
  | 'default'
  | 'silver'
  | 'gold'
  | 'rainbow'
  | 'exclusive-shimmer';
export type MembershipBadge = 'silver' | 'gold' | 'diamond' | 'super-lifetime';
export type FancyNumberVoucher = 'standard' | 'premium';

export interface MembershipQuotaValue {
  actual: number;
  display: MembershipQuotaDisplay;
}

export interface MembershipTier {
  level: MembershipLevel;
  key: MembershipTierKey;
  durationMonths: number | null;
  lifetime: boolean;
  priceCny: number | null;
  recommended: boolean;
  quotas: {
    groupMembers: MembershipQuotaValue;
    joinedCircles: MembershipQuotaValue;
    createdCircles: MembershipQuotaValue;
    notes: MembershipQuotaValue;
    cityFilters: MembershipQuotaValue;
  };
  appearance: {
    nameColor: MembershipNameColor;
    badge: MembershipBadge | null;
  };
  benefits: {
    premiumCircle: boolean;
    fancyNumberVoucher: FancyNumberVoucher | null;
  };
}

export const MEMBERSHIP_CATALOG = [
  {
    level: 0,
    key: 'regular',
    durationMonths: null,
    lifetime: false,
    priceCny: null,
    recommended: false,
    quotas: {
      groupMembers: { actual: 0, display: 'cannot-create' },
      joinedCircles: { actual: 100, display: '100' },
      createdCircles: { actual: 0, display: '0' },
      notes: { actual: 50, display: '50' },
      cityFilters: { actual: 1, display: '1' },
    },
    appearance: { nameColor: 'default', badge: null },
    benefits: { premiumCircle: false, fancyNumberVoucher: null },
  },
  {
    level: 1,
    key: 'silver',
    durationMonths: 1,
    lifetime: false,
    priceCny: 298,
    recommended: false,
    quotas: {
      groupMembers: { actual: 300, display: '300' },
      joinedCircles: { actual: 200, display: '200' },
      createdCircles: { actual: 20, display: '20' },
      notes: { actual: 100, display: '100' },
      cityFilters: { actual: 5, display: '5' },
    },
    appearance: { nameColor: 'silver', badge: 'silver' },
    benefits: { premiumCircle: true, fancyNumberVoucher: null },
  },
  {
    level: 2,
    key: 'gold',
    durationMonths: 6,
    lifetime: false,
    priceCny: 1288,
    recommended: false,
    quotas: {
      groupMembers: { actual: 500, display: '500' },
      joinedCircles: { actual: 500, display: '500' },
      createdCircles: { actual: 100, display: '100' },
      notes: { actual: 500, display: '500' },
      cityFilters: { actual: 20, display: '20' },
    },
    appearance: { nameColor: 'gold', badge: 'gold' },
    benefits: { premiumCircle: true, fancyNumberVoucher: null },
  },
  {
    level: 3,
    key: 'diamond',
    durationMonths: 12,
    lifetime: false,
    priceCny: 1998,
    recommended: true,
    quotas: {
      groupMembers: { actual: 1000, display: '1000' },
      joinedCircles: { actual: 1000, display: '999+' },
      createdCircles: { actual: 300, display: '300' },
      notes: { actual: 1000, display: '999+' },
      cityFilters: { actual: 50, display: '50' },
    },
    appearance: { nameColor: 'rainbow', badge: 'diamond' },
    benefits: { premiumCircle: true, fancyNumberVoucher: 'standard' },
  },
  {
    level: 4,
    key: 'super',
    durationMonths: null,
    lifetime: true,
    priceCny: 3998,
    recommended: false,
    quotas: {
      groupMembers: { actual: 3000, display: '3000' },
      joinedCircles: { actual: 5000, display: 'unlimited' },
      createdCircles: { actual: 3000, display: 'unlimited' },
      notes: { actual: 10000, display: 'unlimited' },
      cityFilters: { actual: 1000, display: 'unlimited' },
    },
    appearance: { nameColor: 'exclusive-shimmer', badge: 'super-lifetime' },
    benefits: { premiumCircle: true, fancyNumberVoucher: 'premium' },
  },
] as const satisfies readonly MembershipTier[];

export interface StoredMembership {
  vipLevel: number;
  vipExpiresAt: Date | null;
}

export function resolveEffectiveMembershipLevel(
  membership: StoredMembership,
  now = new Date(),
): MembershipLevel {
  const { vipLevel, vipExpiresAt } = membership;
  if (
    !Number.isFinite(vipLevel) ||
    !Number.isInteger(vipLevel) ||
    vipLevel <= 0
  ) {
    return 0;
  }
  if (vipLevel >= 4) {
    return 4;
  }
  if (vipExpiresAt !== null && vipExpiresAt.getTime() <= now.getTime()) {
    return 0;
  }
  return vipLevel as 1 | 2 | 3;
}

export function addUtcCalendarMonths(source: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 0) {
    throw new RangeError('months must be a non-negative integer');
  }

  const result = new Date(source.getTime());
  const sourceDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastTargetDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(sourceDay, lastTargetDay));
  return result;
}
