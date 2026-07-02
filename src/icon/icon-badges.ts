import { SystemIconKeyDto } from './dto/icon.dto';

export type EligibilityUser = {
  vipLevel: number;
  // Distinct-recognizer count from CollaborationRecognition — the basis for the
  // Top Collaborator badge tiers (not raw likes).
  recognitionCount: number;
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
};

const VIP_BADGE_LEVELS: LeveledSystemBadgeLevel[] = [1, 2, 3, 4, 5].map(
  (level) => ({
    level,
    variant: `VIP${level}`,
    title: `VIP${level}`,
  }),
);

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
    getEarnedLevel: (user) => user.vipLevel,
  },
  {
    systemKey: SystemIconKeyDto.TOP_COLLABORATOR,
    fallbackIconName: 'ribbon-outline',
    levels: TOP_COLLABORATOR_BADGE_LEVELS,
    getEarnedLevel: (user) =>
      TOP_COLLABORATOR_BADGE_LEVELS.reduce(
        (earnedLevel, tier) =>
          user.recognitionCount >= (tier.recognitionCount ?? Infinity)
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
): EligibleSystemIcon[] {
  const icons: EligibleSystemIcon[] = [];

  for (const definition of LEVELED_SYSTEM_BADGE_DEFINITIONS) {
    const earnedLevel = Math.max(0, definition.getEarnedLevel(user));

    for (const tier of definition.levels) {
      if (tier.level > earnedLevel) {
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
