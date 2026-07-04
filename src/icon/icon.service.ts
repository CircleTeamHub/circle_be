import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IconErrorCode } from 'src/common/app-error-codes';
import {
  DisplayIconDto,
  DisplayIconTypeDto,
  IconOptionsResponseDto,
  SystemIconKeyDto,
  UpdateDisplayIconItemDto,
} from './dto/icon.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import type { PrivacySettingsDto } from 'src/privacy/privacy-settings.dto';
import { SystemIconKey, UserDisplayIconType } from 'src/generated/prisma';
import {
  buildLeveledSystemIcons,
  EligibleSystemIcon,
  isLeveledSystemBadgeKey,
  lastItem,
  systemSelectionKey,
} from './icon-badges';

const NEW_USER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DISPLAY_ICONS = 5;
const CIRCLE_BUILDER_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Circle Builder requires MORE THAN this many members (i.e. >100).
const CIRCLE_BUILDER_MIN_MEMBERS = 100;
// Verified Profile requires a bio of at least this length in one of the fields.
const VERIFIED_PROFILE_MIN_BIO_LENGTH = 10;
// Cap on memberships scanned per user for eligibility — a power user could join
// thousands of circles; the newest are the relevant ones for circle icons and
// Circle Builder only needs one qualifying circle.
const MAX_ELIGIBILITY_CIRCLE_MEMBERSHIPS = 200;
const DISPLAY_ICON_CACHE_TTL_MS = 30_000;
const DISPLAY_ICON_CACHE_MAX_ENTRIES = 5_000;

type CachedDisplayIcons = {
  data: DisplayIconDto[];
  expiresAt: number;
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

// Prefetched inputs for building eligibility, shared by the single-user and
// batch paths so both compute identical results from the same shapes.
type EligibilityUserRow = {
  vipLevel: number;
  receivedLikeCount: number;
  createdAt: Date;
  status: string;
  avatarUrl: string | null;
  nickname: string | null;
  city: string | null;
  email: string | null;
  phoneNumber: string | null;
  wechat: string | null;
  qq: string | null;
  persona: string | null;
  helloWords: string | null;
  whatsup: string | null;
};

type EligibilityCircleMembership = {
  role: string;
  circle: {
    id: string;
    name: string;
    createdAt: Date;
    deleted: boolean;
    memberCount: number;
    currentIconAsset: { id: string; imageUrl: string | null } | null;
  };
};

type StoredSelection = {
  id: string;
  displayType: string;
  systemKey: string | null;
  systemVariant?: string | null;
  circleID: string | null;
  sortOrder: number;
};

// Prisma select shared by every user fetch feeding eligibility.
const ELIGIBILITY_USER_SELECT = {
  id: true,
  vipLevel: true,
  receivedLikeCount: true,
  createdAt: true,
  status: true,
  avatarUrl: true,
  nickname: true,
  city: true,
  email: true,
  phoneNumber: true,
  wechat: true,
  qq: true,
  persona: true,
  helloWords: true,
  whatsup: true,
  iconPreferencesInitialized: true,
} as const;

// Prisma select for active memberships — feeds both circle icons and the
// Circle Builder check, so it carries role and the circle's size/age.
const ELIGIBILITY_CIRCLE_MEMBERSHIP_SELECT = {
  userID: true,
  circleID: true,
  role: true,
  circle: {
    select: {
      id: true,
      name: true,
      createdAt: true,
      deleted: true,
      memberCount: true,
      currentIconAsset: {
        select: {
          id: true,
          imageUrl: true,
        },
      },
    },
  },
} as const;

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

@Injectable()
export class IconService {
  private readonly displayIconCache = new Map<string, CachedDisplayIcons>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly privacySettings: PrivacySettingsService,
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
   * Batched, read-only resolution of display icons for many users at once —
   * used by feeds/lists to avoid an N+1 (each user previously triggered ~5
   * separate queries). Unlike {@link getDisplayIconsForUser} this never
   * persists pruning or default-initialization, since rendering another user's
   * badges must not mutate their stored selections. Every requested id is
   * present in the result (missing users map to an empty array). Results are
   * cached under the same TTL as the single-user path.
   */
  async getDisplayIconsForUsers(
    userIds: string[],
  ): Promise<Map<string, DisplayIconDto[]>> {
    const result = new Map<string, DisplayIconDto[]>();
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    const uncached: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.getCachedDisplayIcons(id);
      if (cached) {
        result.set(id, cached);
      } else {
        uncached.push(id);
      }
    }
    if (uncached.length === 0) return result;

    const [users, memberships, privacyByUser, selections] =
      await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: uncached } },
          select: ELIGIBILITY_USER_SELECT,
        }),
        this.prisma.circleMember.findMany({
          where: {
            userID: { in: uncached },
            status: 'ACTIVE',
            circle: { deleted: false },
          },
          select: ELIGIBILITY_CIRCLE_MEMBERSHIP_SELECT,
          orderBy: { createdAt: 'desc' },
        }),
        this.privacySettings.getSettingsForUsers(uncached),
        this.prisma.userDisplayIcon.findMany({
          where: { userID: { in: uncached } },
          orderBy: { sortOrder: 'asc' },
        }),
      ]);

    const membershipsByUser = new Map<string, EligibilityCircleMembership[]>();
    for (const membership of memberships) {
      const list = membershipsByUser.get(membership.userID) ?? [];
      list.push(membership);
      membershipsByUser.set(membership.userID, list);
    }
    const selectionsByUser = new Map<string, StoredSelection[]>();
    for (const selection of selections) {
      const list = selectionsByUser.get(selection.userID) ?? [];
      list.push(selection);
      selectionsByUser.set(selection.userID, list);
    }

    for (const user of users) {
      const eligibility = this.buildEligibility(
        user,
        membershipsByUser.get(user.id) ?? [],
        // getSettingsForUsers returns an entry (defaults included) for every
        // requested id, so this is always defined for a user in `uncached`.
        privacyByUser.get(user.id) as PrivacySettingsDto,
      );
      const display = this.computeReadonlyDisplayIcons(
        user.id,
        eligibility,
        selectionsByUser.get(user.id) ?? [],
        user.iconPreferencesInitialized,
      );
      this.setCachedDisplayIcons(user.id, display);
      result.set(user.id, display);
    }

    for (const id of uncached) {
      if (!result.has(id)) result.set(id, []);
    }

    return result;
  }

  // Read-only counterpart of ensureSelections: mirrors the same prune +
  // default-initialization display output but computes it in memory without any
  // writes, so batch feed rendering never mutates a viewed user's selections.
  private computeReadonlyDisplayIcons(
    userId: string,
    eligibility: Eligibility,
    selections: StoredSelection[],
    iconPreferencesInitialized: boolean,
  ): DisplayIconDto[] {
    const { valid } = this.partitionSelections(selections, eligibility);
    const normalized = this.normalizeValidSelections(valid, eligibility);

    if (
      normalized.length === 0 &&
      !iconPreferencesInitialized &&
      eligibility.systemIcons.length > 0
    ) {
      const defaults: StoredSelection[] = this.defaultDisplaySystemIcons(
        eligibility,
      ).map((icon, index) => ({
        id: `system:${icon.systemVariant}`,
        displayType: DisplayIconTypeDto.SYSTEM,
        systemKey: icon.systemKey,
        systemVariant: icon.systemVariant,
        circleID: null,
        sortOrder: index,
      }));
      return this.mapSelectionsToDisplayIcons(defaults, eligibility);
    }

    return this.mapSelectionsToDisplayIcons(normalized, eligibility);
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
      throw new BadRequestException({
        message: 'A user can display at most 5 icons',
        errorCode: IconErrorCode.DisplayLimit,
      });
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
    const [user, circleMemberships, privacy] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: ELIGIBILITY_USER_SELECT,
        }),
        this.prisma.circleMember.findMany({
          where: {
            userID: userId,
            status: 'ACTIVE',
            circle: { deleted: false },
          },
          select: ELIGIBILITY_CIRCLE_MEMBERSHIP_SELECT,
          orderBy: { createdAt: 'desc' },
          take: MAX_ELIGIBILITY_CIRCLE_MEMBERSHIPS,
        }),
        this.privacySettings.getSettings(userId),
      ]);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.buildEligibility(
      user,
      circleMemberships,
      privacy,
    );
  }

  // Pure eligibility assembly from prefetched rows. Kept side-effect-free so the
  // single-user and batch paths produce identical results from identical data.
  private buildEligibility(
    user: EligibilityUserRow,
    circleMemberships: EligibilityCircleMembership[],
    privacy: PrivacySettingsDto,
  ): Eligibility {
    const systemIcons: EligibleSystemIcon[] = buildLeveledSystemIcons({
      vipLevel: user.vipLevel,
      receivedLikeCount: user.receivedLikeCount,
    });
    if (Date.now() - user.createdAt.getTime() <= NEW_USER_MS) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.NEW_USER,
        systemVariant: SystemIconKeyDto.NEW_USER,
        title: '新手',
        fallbackIconName: 'rocket-outline',
        imageUrl: null,
      });
    }

    if (this.isVerifiedProfileEligible(user, privacy)) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.VERIFIED_PROFILE,
        systemVariant: SystemIconKeyDto.VERIFIED_PROFILE,
        title: '资料可信',
        fallbackIconName: 'shield-checkmark-outline',
        imageUrl: null,
      });
    }

    if (this.hasCircleBuilderCircle(circleMemberships)) {
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

  // Verified Profile: an ACTIVE user with a complete profile (avatar, nickname,
  // city, email, a real bio) and at least one publicly-shown contact method.
  private isVerifiedProfileEligible(
    user: EligibilityUserRow,
    privacy: PrivacySettingsDto,
  ): boolean {
    if (user.status !== 'ACTIVE') return false;

    const hasPublicContact =
      (this.hasText(user.phoneNumber) && privacy.showPhone) ||
      (this.hasText(user.wechat) && privacy.showWechat) ||
      (this.hasText(user.qq) && privacy.showQQ);
    const hasBio = [user.persona, user.helloWords, user.whatsup].some((value) =>
      this.hasText(value, VERIFIED_PROFILE_MIN_BIO_LENGTH),
    );

    return (
      this.hasText(user.avatarUrl) &&
      this.hasText(user.nickname) &&
      this.hasText(user.city) &&
      this.hasText(user.email) &&
      hasBio &&
      hasPublicContact
    );
  }

  // Circle Builder: OWNER/ADMIN of a live circle with >100 members, aged ≥7d.
  private hasCircleBuilderCircle(
    memberships: EligibilityCircleMembership[],
  ): boolean {
    const now = Date.now();
    return memberships.some((membership) => {
      if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
        return false;
      }
      if (membership.circle.deleted) return false;
      if (membership.circle.memberCount <= CIRCLE_BUILDER_MIN_MEMBERS) {
        return false;
      }
      return (
        now - membership.circle.createdAt.getTime() >= CIRCLE_BUILDER_MIN_AGE_MS
      );
    });
  }

  private hasText(value: string | null | undefined, minLength = 1): boolean {
    return typeof value === 'string' && value.trim().length >= minLength;
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

    const { valid, stale } = this.partitionSelections(selections, eligibility);

    if (stale.length > 0) {
      await this.prisma.userDisplayIcon.deleteMany({
        where: {
          id: { in: stale.map((item) => item.id) },
        },
      });
      this.invalidateDisplayIconCache(userId);
    }

    return this.normalizeValidSelections(valid, eligibility);
  }

  // Pure split of persisted selections into those still backed by current
  // eligibility and those that are stale. No I/O — reused by the batch path so
  // rendering another user's badges never mutates their stored selections.
  private partitionSelections(
    selections: StoredSelection[],
    eligibility: Eligibility,
  ): { valid: StoredSelection[]; stale: StoredSelection[] } {
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

    const staleIds = new Set(stale.map((item) => item.id));
    return {
      valid: selections.filter((selection) => !staleIds.has(selection.id)),
      stale,
    };
  }

  private normalizeValidSelections(
    valid: StoredSelection[],
    eligibility: Eligibility,
  ) {
    return valid
      .slice()
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
          throw new BadRequestException({
            message: 'Invalid system icon selection',
            errorCode: IconErrorCode.InvalidSystemSelection,
          });
        }
        item.systemVariant = systemVariant ?? undefined;
        continue;
      }

      if (!item.circleId || !circleIds.has(item.circleId)) {
        throw new BadRequestException({
          message: 'Invalid circle icon selection',
          errorCode: IconErrorCode.InvalidCircleSelection,
        });
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
        throw new BadRequestException({
          message: 'Duplicate icon selection',
          errorCode: IconErrorCode.DuplicateSelection,
        });
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
