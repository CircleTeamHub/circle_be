import { SystemIconKeyDto } from './dto/icon.dto';
import { resolveEffectiveMembershipLevel } from 'src/membership/membership.catalog';

export type EligibilityUser = {
  vipLevel: number;
  vipExpiresAt: Date | null;
  // Denormalized total likes/recognitions received by the user. This is the
  // persisted source of truth for Top Collaborator badge tiers.
  receivedLikeCount: number;
};

export type EligibleSystemIcon = {
  systemKey: SystemIconKeyDto;
  systemVariant: string;
  title: string;
  fallbackIconName: string;
  imageUrl: string | null;
  recognitionCount?: number;
};

type LeveledSystemBadgeLevel = {
  level: number;
  variant: string;
  title: string;
  recognitionCount?: number;
};

type LeveledSystemBadgeDefinition = {
  systemKey: SystemIconKeyDto;
  fallbackIconName: string;
  levels: LeveledSystemBadgeLevel[];
  getEarnedLevel: (user: EligibilityUser) => number;
  currentLevelOnly?: boolean;
};

const VIP_BADGE_LEVELS: LeveledSystemBadgeLevel[] = [
  { level: 1, variant: 'VIP1', title: '白银会员' },
  { level: 2, variant: 'VIP2', title: '黄金会员' },
  { level: 3, variant: 'VIP3', title: '钻石会员' },
  { level: 4, variant: 'VIP4', title: '超级会员' },
];

const TOP_COLLABORATOR_BADGE_LEVELS: LeveledSystemBadgeLevel[] = [
  {
    level: 1,
    variant: 'TOP_COLLABORATOR_1',
    title: '合作达人1',
    recognitionCount: 100,
  },
  {
    level: 2,
    variant: 'TOP_COLLABORATOR_2',
    title: '合作达人2',
    recognitionCount: 1000,
  },
  {
    level: 3,
    variant: 'TOP_COLLABORATOR_3',
    title: '合作达人3',
    recognitionCount: 10_000,
  },
];

const LEVELED_SYSTEM_BADGE_DEFINITIONS: LeveledSystemBadgeDefinition[] = [
  {
    systemKey: SystemIconKeyDto.VIP,
    fallbackIconName: 'diamond',
    levels: VIP_BADGE_LEVELS,
    getEarnedLevel: () => 0,
    currentLevelOnly: true,
  },
  {
    systemKey: SystemIconKeyDto.TOP_COLLABORATOR,
    fallbackIconName: 'ribbon-outline',
    levels: TOP_COLLABORATOR_BADGE_LEVELS,
    getEarnedLevel: (user) =>
      TOP_COLLABORATOR_BADGE_LEVELS.reduce(
        (earnedLevel, tier) =>
          user.receivedLikeCount >= (tier.recognitionCount ?? Infinity)
            ? tier.level
            : earnedLevel,
        0,
      ),
  },
];

const LEVELED_SYSTEM_BADGE_KEYS = new Set(
  LEVELED_SYSTEM_BADGE_DEFINITIONS.map((definition) => definition.systemKey),
);

export function systemSelectionKey(
  systemKey: SystemIconKeyDto | string | null | undefined,
  systemVariant: string | null | undefined,
): string {
  return `${systemKey ?? ''}:${systemVariant ?? ''}`;
}

export function lastItem<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

export function isLeveledSystemBadgeKey(
  systemKey: string | null | undefined,
): boolean {
  return Boolean(
    systemKey && LEVELED_SYSTEM_BADGE_KEYS.has(systemKey as SystemIconKeyDto),
  );
}

export function buildLeveledSystemIcons(
  user: EligibilityUser,
  now = new Date(),
): EligibleSystemIcon[] {
  const icons: EligibleSystemIcon[] = [];

  for (const definition of LEVELED_SYSTEM_BADGE_DEFINITIONS) {
    const earnedLevel = Math.max(
      0,
      definition.systemKey === SystemIconKeyDto.VIP
        ? resolveEffectiveMembershipLevel(user, now)
        : definition.getEarnedLevel(user),
    );

    for (const tier of definition.levels) {
      if (
        definition.currentLevelOnly
          ? tier.level !== earnedLevel
          : tier.level > earnedLevel
      ) {
        continue;
      }

      icons.push({
        systemKey: definition.systemKey,
        systemVariant: tier.variant,
        title: tier.title,
        fallbackIconName: definition.fallbackIconName,
        imageUrl: null,
        recognitionCount: tier.recognitionCount,
      });
    }
  }

  return icons;
}
