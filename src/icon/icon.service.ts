import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DisplayIconDto,
  DisplayIconTypeDto,
  IconOptionsResponseDto,
  SystemIconKeyDto,
  UpdateDisplayIconItemDto,
} from './dto/icon.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { SystemIconKey, UserDisplayIconType } from 'src/generated/prisma';

const NEW_USER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DISPLAY_ICONS = 5;
const CIRCLE_BUILDER_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CIRCLE_BUILDER_MIN_MEMBERS = 100;
const DISPLAY_ICON_CACHE_TTL_MS = 30_000;
const DISPLAY_ICON_CACHE_MAX_ENTRIES = 5_000;

type EligibilityUser = {
  vipLevel: number;
  receivedLikeCount: number;
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

type CachedDisplayIcons = {
  data: DisplayIconDto[];
  expiresAt: number;
};

type EligibleSystemIcon = {
  systemKey: SystemIconKeyDto;
  systemVariant: string;
  title: string;
  fallbackIconName: string;
  imageUrl: string | null;
  recognitionCount?: number;
};

type EligibleCircleIcon = {
  circleId: string;
  circleName: string;
  imageUrl: string | null;
  fallbackIconName: string | null;
};

type Eligibility = {
  systemIcons: EligibleSystemIcon[];
  circleIcons: EligibleCircleIcon[];
};

function toPrismaDisplayIconType(
  displayType: DisplayIconTypeDto,
): UserDisplayIconType {
  return displayType as unknown as UserDisplayIconType;
}

function toPrismaSystemIconKey(
  systemKey: SystemIconKeyDto | null | undefined,
): SystemIconKey | null {
  return (systemKey as unknown as SystemIconKey | undefined) ?? null;
}

function systemSelectionKey(
  systemKey: SystemIconKeyDto | string | null | undefined,
  systemVariant: string | null | undefined,
): string {
  return `${systemKey ?? ''}:${systemVariant ?? ''}`;
}

function lastItem<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

function isLeveledSystemBadgeKey(
  systemKey: string | null | undefined,
): boolean {
  return Boolean(
    systemKey && LEVELED_SYSTEM_BADGE_KEYS.has(systemKey as SystemIconKeyDto),
  );
}

function buildLeveledSystemIcons(user: EligibilityUser): EligibleSystemIcon[] {
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

@Injectable()
export class IconService {
  private readonly displayIconCache = new Map<string, CachedDisplayIcons>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
  ) {}

  private invalidateDisplayIconCache(userId: string): void {
    this.displayIconCache.delete(userId);
  }

  private getCachedDisplayIcons(userId: string): DisplayIconDto[] | null {
    const entry = this.displayIconCache.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.displayIconCache.delete(userId);
      return null;
    }
    return entry.data;
  }

  private setCachedDisplayIcons(userId: string, data: DisplayIconDto[]): void {
    if (this.displayIconCache.size >= DISPLAY_ICON_CACHE_MAX_ENTRIES) {
      // Simple eviction: drop the oldest insertion-order entry.
      const oldestKey = this.displayIconCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.displayIconCache.delete(oldestKey);
      }
    }
    this.displayIconCache.set(userId, {
      data,
      expiresAt: Date.now() + DISPLAY_ICON_CACHE_TTL_MS,
    });
  }

  async getIconOptions(userId: string): Promise<IconOptionsResponseDto> {
    const eligibility = await this.resolveEligibility(userId);
    const selections = await this.ensureSelections(userId, eligibility);

    return {
      systemIcons: eligibility.systemIcons.map((icon) => ({
        type: DisplayIconTypeDto.SYSTEM,
        title: icon.title,
        imageUrl: icon.imageUrl,
        fallbackIconName: icon.fallbackIconName,
        recognitionCount: icon.recognitionCount,
        selected: selections.some(
          (item) =>
            item.systemKey === icon.systemKey &&
            this.resolveSelectionSystemVariant(item, eligibility) ===
              icon.systemVariant,
        ),
        systemKey: icon.systemKey,
        systemVariant: icon.systemVariant,
      })),
      circleIcons: eligibility.circleIcons.map((icon) => ({
        type: DisplayIconTypeDto.CIRCLE,
        title: icon.circleName,
        imageUrl: icon.imageUrl,
        fallbackIconName: icon.fallbackIconName,
        selected: selections.some((item) => item.circleID === icon.circleId),
        circleId: icon.circleId,
        circleName: icon.circleName,
      })),
      displayIcons: this.mapSelectionsToDisplayIcons(selections, eligibility),
    };
  }

  async getDisplayIconsForUser(userId: string): Promise<DisplayIconDto[]> {
    const cached = this.getCachedDisplayIcons(userId);
    if (cached) return cached;

    const eligibility = await this.resolveEligibility(userId);
    const selections = await this.ensureSelections(userId, eligibility);
    const result = this.mapSelectionsToDisplayIcons(selections, eligibility);
    this.setCachedDisplayIcons(userId, result);
    return result;
  }

  /**
   * Public cache invalidation for callers that mutate state IconService can't
   * observe directly (e.g. circle icon swaps that affect circle eligibility).
   */
  invalidateDisplayIconCacheFor(userId: string): void {
    this.invalidateDisplayIconCache(userId);
  }

  async updateDisplayIcons(
    userId: string,
    items: UpdateDisplayIconItemDto[],
  ): Promise<DisplayIconDto[]> {
    if (items.length > MAX_DISPLAY_ICONS) {
      throw new BadRequestException('A user can display at most 5 icons');
    }

    const eligibility = await this.resolveEligibility(userId);
    this.assertItemsEligible(items, eligibility);
    this.assertUniqueSelections(items);

    const normalized = [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item, index) => ({ ...item, sortOrder: index }));

    await this.prisma.$transaction(async (tx) => {
      await tx.userDisplayIcon.deleteMany({
        where: { userID: userId },
      });

      if (normalized.length > 0) {
        await tx.userDisplayIcon.createMany({
          data: normalized.map((item) => ({
            userID: userId,
            displayType: toPrismaDisplayIconType(item.displayType),
            systemKey: toPrismaSystemIconKey(item.systemKey),
            systemVariant: item.systemVariant ?? null,
            circleID: item.circleId ?? null,
            sortOrder: item.sortOrder,
          })),
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: { iconPreferencesInitialized: true },
      });
    });

    this.invalidateDisplayIconCache(userId);
    await this.realtimeService.invalidateUserProfileSummaryCache(userId);

    const displayIcons = this.mapSelectionsToDisplayIcons(
      normalized.map((item) => ({
        id:
          item.displayType === DisplayIconTypeDto.SYSTEM
            ? `system:${item.systemKey}`
            : `circle:${item.circleId}`,
        userID: userId,
        displayType: item.displayType,
        systemKey: item.systemKey ?? null,
        systemVariant: item.systemVariant ?? null,
        circleID: item.circleId ?? null,
        sortOrder: item.sortOrder,
      })),
      eligibility,
    );

    await this.realtimeService.broadcastUserProfileSummary(userId);

    return displayIcons;
  }

  private async resolveEligibility(userId: string): Promise<Eligibility> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        vipLevel: true,
        receivedLikeCount: true,
        createdAt: true,
        status: true,
        phoneNumber: true,
        wechat: true,
        qq: true,
        iconPreferencesInitialized: true,
        privacySetting: {
          select: {
            showPhone: true,
            showWechat: true,
            showQQ: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [circleMemberships, builderMembership] = await Promise.all([
      this.prisma.circleMember.findMany({
        where: {
          userID: userId,
          status: 'ACTIVE',
          circle: {
            deleted: false,
            currentIconAssetID: { not: null },
          },
        },
        select: {
          circleID: true,
          circle: {
            select: {
              id: true,
              name: true,
              currentIconAsset: {
                select: {
                  id: true,
                  imageUrl: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.circleMember.findFirst({
        where: {
          userID: userId,
          status: 'ACTIVE',
          role: { in: ['OWNER', 'ADMIN'] },
          circle: {
            deleted: false,
            createdAt: {
              lte: new Date(Date.now() - CIRCLE_BUILDER_MIN_AGE_MS),
            },
            memberCount: { gt: CIRCLE_BUILDER_MIN_MEMBERS },
          },
        },
        select: { id: true },
      }),
    ]);

    const systemIcons: EligibleSystemIcon[] = buildLeveledSystemIcons(user);
    if (Date.now() - user.createdAt.getTime() <= NEW_USER_MS) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.NEW_USER,
        systemVariant: SystemIconKeyDto.NEW_USER,
        title: '新手',
        fallbackIconName: 'rocket-outline',
        imageUrl: null,
      });
    }

    const canShowPhone =
      (user.privacySetting?.showPhone ?? false) && Boolean(user.phoneNumber);
    const canShowWechat =
      (user.privacySetting?.showWechat ?? true) && Boolean(user.wechat);
    const canShowQQ = (user.privacySetting?.showQQ ?? true) && Boolean(user.qq);
    if (
      user.status === 'ACTIVE' &&
      (canShowPhone || canShowWechat || canShowQQ)
    ) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.VERIFIED_PROFILE,
        systemVariant: SystemIconKeyDto.VERIFIED_PROFILE,
        title: '资料可信',
        fallbackIconName: 'shield-checkmark-outline',
        imageUrl: null,
      });
    }

    if (builderMembership) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.CIRCLE_BUILDER,
        systemVariant: SystemIconKeyDto.CIRCLE_BUILDER,
        title: '圈子建设者',
        fallbackIconName: 'construct-outline',
        imageUrl: null,
      });
    }

    const circleIcons: EligibleCircleIcon[] = circleMemberships
      .filter((membership) => membership.circle.currentIconAsset)
      .map((membership) => ({
        circleId: membership.circle.id,
        circleName: membership.circle.name,
        imageUrl: membership.circle.currentIconAsset?.imageUrl ?? null,
        fallbackIconName: 'people-circle-outline',
      }));

    return { systemIcons, circleIcons };
  }

  private resolveSelectionSystemVariant(
    selection: {
      systemKey: string | null;
      systemVariant?: string | null;
    },
    eligibility: Eligibility,
  ): string | null {
    const isLegacyPlaceholderVariant =
      selection.systemVariant &&
      selection.systemVariant === selection.systemKey &&
      isLeveledSystemBadgeKey(selection.systemKey);

    if (selection.systemVariant && !isLegacyPlaceholderVariant) {
      return selection.systemVariant;
    }

    if (!selection.systemKey) {
      return null;
    }

    if (isLeveledSystemBadgeKey(selection.systemKey)) {
      const leveledIcons = eligibility.systemIcons.filter(
        (icon) => icon.systemKey === selection.systemKey,
      );
      return lastItem(leveledIcons)?.systemVariant ?? selection.systemKey;
    }

    return selection.systemKey;
  }

  private defaultDisplaySystemIcons(
    eligibility: Eligibility,
  ): EligibleSystemIcon[] {
    const byKey = (systemKey: SystemIconKeyDto) =>
      eligibility.systemIcons.filter((icon) => icon.systemKey === systemKey);
    const preferred = [
      lastItem(byKey(SystemIconKeyDto.VIP)),
      lastItem(byKey(SystemIconKeyDto.NEW_USER)),
      lastItem(byKey(SystemIconKeyDto.TOP_COLLABORATOR)),
      lastItem(byKey(SystemIconKeyDto.VERIFIED_PROFILE)),
      lastItem(byKey(SystemIconKeyDto.CIRCLE_BUILDER)),
    ].filter((icon): icon is EligibleSystemIcon => Boolean(icon));

    if (preferred.length >= MAX_DISPLAY_ICONS) {
      return preferred.slice(0, MAX_DISPLAY_ICONS);
    }

    const preferredVariants = new Set(
      preferred.map((icon) =>
        systemSelectionKey(icon.systemKey, icon.systemVariant),
      ),
    );
    const fill = eligibility.systemIcons.filter(
      (icon) =>
        !preferredVariants.has(
          systemSelectionKey(icon.systemKey, icon.systemVariant),
        ),
    );

    return [...preferred, ...fill].slice(0, MAX_DISPLAY_ICONS);
  }

  private async pruneInvalidSelections(
    userId: string,
    eligibility: Eligibility,
  ) {
    const selections = await this.prisma.userDisplayIcon.findMany({
      where: { userID: userId },
      orderBy: { sortOrder: 'asc' },
    });

    const validSystemKeys = new Set(
      eligibility.systemIcons.map((item) =>
        systemSelectionKey(item.systemKey, item.systemVariant),
      ),
    );
    const validCircleIds = new Set(
      eligibility.circleIcons.map((item) => item.circleId),
    );

    const stale = selections.filter((selection) => {
      if (
        selection.displayType === DisplayIconTypeDto.SYSTEM &&
        selection.systemKey
      ) {
        return !validSystemKeys.has(
          systemSelectionKey(
            selection.systemKey,
            this.resolveSelectionSystemVariant(selection, eligibility),
          ),
        );
      }
      if (
        selection.displayType === DisplayIconTypeDto.CIRCLE &&
        selection.circleID
      ) {
        return !validCircleIds.has(selection.circleID);
      }
      return true;
    });

    if (stale.length > 0) {
      await this.prisma.userDisplayIcon.deleteMany({
        where: {
          id: { in: stale.map((item) => item.id) },
        },
      });
      this.invalidateDisplayIconCache(userId);
    }

    return selections
      .filter((selection) => !stale.some((item) => item.id === selection.id))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((selection, index) => ({
        ...selection,
        systemVariant: this.resolveSelectionSystemVariant(
          selection,
          eligibility,
        ),
        sortOrder: index,
      }));
  }

  private async ensureSelections(userId: string, eligibility: Eligibility) {
    const selections = await this.pruneInvalidSelections(userId, eligibility);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { iconPreferencesInitialized: true },
    });

    if (
      selections.length === 0 &&
      user &&
      !user.iconPreferencesInitialized &&
      eligibility.systemIcons.length > 0
    ) {
      const defaults = this.defaultDisplaySystemIcons(eligibility).map(
        (icon, index) => ({
          id: `system:${icon.systemVariant}`,
          userID: userId,
          displayType: toPrismaDisplayIconType(DisplayIconTypeDto.SYSTEM),
          systemKey: toPrismaSystemIconKey(icon.systemKey),
          systemVariant: icon.systemVariant,
          circleID: null,
          sortOrder: index,
        }),
      );

      try {
        await this.prisma.userDisplayIcon.createMany({
          data: defaults.map(({ id, ...item }) => item),
        });
        await this.prisma.user.update({
          where: { id: userId },
          data: { iconPreferencesInitialized: true },
        });
        this.invalidateDisplayIconCache(userId);

        return defaults;
      } catch {
        // Concurrent init race — re-read actual selections
        this.invalidateDisplayIconCache(userId);
        return this.prisma.userDisplayIcon.findMany({
          where: { userID: userId },
          orderBy: { sortOrder: 'asc' },
        });
      }
    }

    return selections;
  }

  private assertItemsEligible(
    items: UpdateDisplayIconItemDto[],
    eligibility: Eligibility,
  ): void {
    const systemKeys = new Set(
      eligibility.systemIcons.map((item) =>
        systemSelectionKey(item.systemKey, item.systemVariant),
      ),
    );
    const circleIds = new Set(
      eligibility.circleIcons.map((item) => item.circleId),
    );

    for (const item of items) {
      if (item.displayType === DisplayIconTypeDto.SYSTEM) {
        const systemVariant =
          item.systemVariant ??
          this.resolveSelectionSystemVariant(
            {
              systemKey: item.systemKey ?? null,
            },
            eligibility,
          );
        if (
          !item.systemKey ||
          !systemKeys.has(systemSelectionKey(item.systemKey, systemVariant))
        ) {
          throw new BadRequestException('Invalid system icon selection');
        }
        item.systemVariant = systemVariant ?? undefined;
        continue;
      }

      if (!item.circleId || !circleIds.has(item.circleId)) {
        throw new BadRequestException('Invalid circle icon selection');
      }
    }
  }

  private assertUniqueSelections(items: UpdateDisplayIconItemDto[]): void {
    const seen = new Set<string>();

    for (const item of items) {
      const key =
        item.displayType === DisplayIconTypeDto.SYSTEM
          ? `system:${item.systemKey ?? ''}:${item.systemVariant ?? ''}`
          : `circle:${item.circleId ?? ''}`;

      if (seen.has(key)) {
        throw new BadRequestException('Duplicate icon selection');
      }
      seen.add(key);
    }
  }

  private mapSelectionsToDisplayIcons(
    selections: Array<{
      id: string;
      displayType: string;
      systemKey: string | null;
      systemVariant?: string | null;
      circleID: string | null;
      sortOrder: number;
    }>,
    eligibility: Eligibility,
  ): DisplayIconDto[] {
    const systemMap = new Map(
      eligibility.systemIcons.map((item) => [
        systemSelectionKey(item.systemKey, item.systemVariant),
        item,
      ]),
    );
    const circleMap = new Map(
      eligibility.circleIcons.map((item) => [item.circleId, item]),
    );

    return selections
      .map((selection) => {
        if (
          selection.displayType === DisplayIconTypeDto.SYSTEM &&
          selection.systemKey
        ) {
          const icon = systemMap.get(
            systemSelectionKey(
              selection.systemKey,
              this.resolveSelectionSystemVariant(selection, eligibility),
            ),
          );
          if (!icon) return null;

          return {
            id: `system:${icon.systemVariant}`,
            type: DisplayIconTypeDto.SYSTEM,
            title: icon.title,
            imageUrl: icon.imageUrl,
            fallbackIconName: icon.fallbackIconName,
            recognitionCount: icon.recognitionCount,
            systemKey: icon.systemKey,
            systemVariant: icon.systemVariant,
            sortOrder: selection.sortOrder,
          };
        }

        if (
          selection.displayType === DisplayIconTypeDto.CIRCLE &&
          selection.circleID
        ) {
          const icon = circleMap.get(selection.circleID);
          if (!icon) return null;

          return {
            id: selection.id,
            type: DisplayIconTypeDto.CIRCLE,
            title: icon.circleName,
            imageUrl: icon.imageUrl,
            fallbackIconName: icon.fallbackIconName,
            circleId: icon.circleId,
            circleName: icon.circleName,
            sortOrder: selection.sortOrder,
          };
        }

        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }
}
