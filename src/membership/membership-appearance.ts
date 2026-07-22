import {
  MEMBERSHIP_CATALOG,
  MembershipBadge,
  MembershipLevel,
  MembershipNameColor,
  MembershipTierKey,
  resolveEffectiveMembershipLevel,
  StoredMembership,
} from './membership.catalog';

export type PublicMembershipAppearance = {
  effectiveLevel: MembershipLevel;
  key: MembershipTierKey;
  appearance: {
    nameColor: MembershipNameColor;
    badge: MembershipBadge | null;
  };
};

export type EffectiveMembershipAppearance = PublicMembershipAppearance & {
  active: boolean;
  lifetime: boolean;
};

export function resolveMembershipAppearance(
  membership: StoredMembership,
  now = new Date(),
): EffectiveMembershipAppearance {
  const effectiveLevel = resolveEffectiveMembershipLevel(membership, now);
  const tier = MEMBERSHIP_CATALOG[effectiveLevel];

  return {
    effectiveLevel,
    key: tier.key,
    appearance: { ...tier.appearance },
    active: effectiveLevel > 0,
    lifetime: tier.lifetime,
  };
}

export function toPublicMembershipAppearance(
  membership: StoredMembership,
  now = new Date(),
): PublicMembershipAppearance {
  const resolved = resolveMembershipAppearance(membership, now);
  return {
    effectiveLevel: resolved.effectiveLevel,
    key: resolved.key,
    appearance: resolved.appearance,
  };
}
