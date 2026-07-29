export type MembershipLevel = 0 | 1 | 2 | 3 | 4;
export type MembershipTierKey =
  | 'regular'
  | 'silver'
  | 'gold'
  | 'diamond'
  | 'super';
export type MembershipQuotaDisplay = `${number}` | '999+' | 'unlimited';
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
    notes: MembershipQuotaValue;
    cityFilters: MembershipQuotaValue;
  };
  appearance: {
    nameColor: MembershipNameColor;
    badge: MembershipBadge | null;
  };
  benefits: {
    fancyNumberVoucher: FancyNumberVoucher | null;
    permanentFancyNumber: boolean;
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
      groupMembers: { actual: 100, display: '100' },
      joinedCircles: { actual: 100, display: '100' },
      notes: { actual: 50, display: '50' },
      cityFilters: { actual: 0, display: '0' },
    },
    appearance: { nameColor: 'default', badge: null },
    benefits: { fancyNumberVoucher: null, permanentFancyNumber: false },
  },
  {
    level: 1,
    key: 'silver',
    durationMonths: 1,
    lifetime: false,
    priceCny: 298,
    recommended: false,
    quotas: {
      groupMembers: { actual: 200, display: '200' },
      joinedCircles: { actual: 200, display: '200' },
      notes: { actual: 100, display: '100' },
      cityFilters: { actual: 2, display: '2' },
    },
    appearance: { nameColor: 'silver', badge: 'silver' },
    benefits: { fancyNumberVoucher: null, permanentFancyNumber: false },
  },
  {
    level: 2,
    key: 'gold',
    durationMonths: 6,
    lifetime: false,
    priceCny: 1288,
    recommended: false,
    quotas: {
      groupMembers: { actual: 400, display: '400' },
      joinedCircles: { actual: 300, display: '300' },
      notes: { actual: 500, display: '500' },
      cityFilters: { actual: 10, display: '10' },
    },
    appearance: { nameColor: 'gold', badge: 'gold' },
    benefits: { fancyNumberVoucher: null, permanentFancyNumber: false },
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
      joinedCircles: { actual: 1000, display: '1000' },
      notes: { actual: 1000, display: '1000' },
      cityFilters: { actual: 50, display: '50' },
    },
    appearance: { nameColor: 'rainbow', badge: 'diamond' },
    benefits: { fancyNumberVoucher: null, permanentFancyNumber: false },
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
      joinedCircles: { actual: 2000, display: 'unlimited' },
      notes: { actual: 3000, display: '3000' },
      cityFilters: { actual: 1000, display: 'unlimited' },
    },
    appearance: { nameColor: 'exclusive-shimmer', badge: 'super-lifetime' },
    benefits: { fancyNumberVoucher: null, permanentFancyNumber: true },
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
  const { vipLevel } = membership;
  const vipExpiresAt = membership.vipExpiresAt ?? null;
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
