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
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import type { PrivacySettingsDto } from 'src/privacy/privacy-settings.dto';

const NEW_USER_MS = 30 * 24 * 60 * 60 * 1000;
const CIRCLE_BUILDER_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Circle Builder requires a circle with MORE THAN this many members
// (i.e. >100); a circle with exactly 100 members does not qualify.
const CIRCLE_BUILDER_MEMBER_THRESHOLD = 100;
const TOP_COLLABORATOR_MIN_RECOGNITIONS = 100;
const VERIFIED_PROFILE_MIN_BIO_LENGTH = 10;
const MAX_DISPLAY_ICONS = 5;
// 被赞总数达到该阈值即获得合作达人（PARTNER）徽章。随时可改。
const PARTNER_LIKE_THRESHOLD = 3;
// Upper bound on memberships scanned for icon eligibility. A user can join many
// circles; without a cap a power user would load thousands of rows on every
// icon-options / display-icon fetch. The newest memberships are the relevant
// ones for circle icons, and Circle Builder only needs one qualifying circle.
const MAX_ELIGIBILITY_CIRCLE_MEMBERSHIPS = 200;
const DISPLAY_ICON_CACHE_TTL_MS = 30_000;
const DISPLAY_ICON_CACHE_MAX_ENTRIES = 5_000;

type CachedDisplayIcons = {
  data: DisplayIconDto[];
  expiresAt: number;
};

type EligibleSystemIcon = {
  systemKey: SystemIconKeyDto;
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
        selected: selections.some((item) => item.systemKey === icon.systemKey),
        systemKey: icon.systemKey,
        recognitionCount: icon.recognitionCount,
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
            displayType: item.displayType,
            systemKey: item.systemKey ?? null,
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
        iconPreferencesInitialized: true,
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
        status: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [circleMemberships, recognizerGroups, privacy] = await Promise.all([
      this.prisma.circleMember.findMany({
        where: {
          userID: userId,
          status: 'ACTIVE',
          circle: {
            deleted: false,
          },
        },
        select: {
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
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_ELIGIBILITY_CIRCLE_MEMBERSHIPS,
      }),
      // Count DISTINCT recognizers, not raw recognitions: a meaningful badge is
      // "N different people recognized you", which can't be gamed by one author
      // recognizing the same colluder across many of their own posts.
      this.prisma.collaborationRecognition.groupBy({
        by: ['recognizerID'],
        where: {
          recipientID: userId,
          revokedAt: null,
        },
      }),
      this.privacySettings.getSettings(userId),
    ]);
    const recognitionCount = recognizerGroups.length;

    const systemIcons: EligibleSystemIcon[] = [];
    if (user.vipLevel > 0) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.VIP,
        title: `VIP${user.vipLevel}`,
        fallbackIconName: 'diamond',
        imageUrl: null,
      });
    }
    if (Date.now() - user.createdAt.getTime() <= NEW_USER_MS) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.NEW_USER,
        title: '新手',
        fallbackIconName: 'rocket-outline',
        imageUrl: null,
      });
    }
    if (recognitionCount >= TOP_COLLABORATOR_MIN_RECOGNITIONS) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.TOP_COLLABORATOR,
        title: 'Top Collaborator',
        fallbackIconName: 'star-outline',
        imageUrl: null,
        recognitionCount,
      });
    }
    if (this.isVerifiedProfileEligible(user, privacy)) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.VERIFIED_PROFILE,
        title: 'Verified Profile',
        fallbackIconName: 'shield-checkmark-outline',
        imageUrl: null,
      });
    }
    if (this.hasCircleBuilderCircle(circleMemberships)) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.CIRCLE_BUILDER,
        title: 'Circle Builder',
        fallbackIconName: 'construct-outline',
        imageUrl: null,
      });
    }

    // 合作达人：被赞总数达到阈值即获得。
    if (user.receivedLikeCount >= PARTNER_LIKE_THRESHOLD) {
      systemIcons.push({
        systemKey: SystemIconKeyDto.PARTNER,
        title: '合作达人',
        fallbackIconName: 'ribbon-outline',
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

  private isVerifiedProfileEligible(
    user: {
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
      status: string;
    },
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

  private hasCircleBuilderCircle(
    memberships: Array<{
      role: string;
      circle: {
        createdAt: Date;
        deleted: boolean;
        memberCount: number;
      };
    }>,
  ): boolean {
    const now = Date.now();
    return memberships.some((membership) => {
      if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
        return false;
      }
      if (membership.circle.deleted) {
        return false;
      }
      if (membership.circle.memberCount <= CIRCLE_BUILDER_MEMBER_THRESHOLD) {
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
  private async pruneInvalidSelections(
    userId: string,
    eligibility: Eligibility,
  ) {
    const selections = await this.prisma.userDisplayIcon.findMany({
      where: { userID: userId },
      orderBy: { sortOrder: 'asc' },
    });

    const validSystemKeys = new Set(
      eligibility.systemIcons.map((item) => item.systemKey),
    );
    const validCircleIds = new Set(
      eligibility.circleIcons.map((item) => item.circleId),
    );

    const stale = selections.filter((selection) => {
      if (
        selection.displayType === DisplayIconTypeDto.SYSTEM &&
        selection.systemKey
      ) {
        return !validSystemKeys.has(selection.systemKey as SystemIconKeyDto);
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
      .map((selection, index) => ({ ...selection, sortOrder: index }));
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
      const defaults = eligibility.systemIcons
        .slice(0, MAX_DISPLAY_ICONS)
        .map((icon, index) => ({
          id: `system:${icon.systemKey}`,
          userID: userId,
          displayType: DisplayIconTypeDto.SYSTEM,
          systemKey: icon.systemKey,
          circleID: null,
          sortOrder: index,
        }));

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
      eligibility.systemIcons.map((item) => item.systemKey),
    );
    const circleIds = new Set(
      eligibility.circleIcons.map((item) => item.circleId),
    );

    for (const item of items) {
      if (item.displayType === DisplayIconTypeDto.SYSTEM) {
        if (!item.systemKey || !systemKeys.has(item.systemKey)) {
          throw new BadRequestException('Invalid system icon selection');
        }
        continue;
      }

      if (!item.circleId || !circleIds.has(item.circleId)) {
        throw new BadRequestException('Invalid circle icon selection');
      }
    }
  }

  private mapSelectionsToDisplayIcons(
    selections: Array<{
      id: string;
      displayType: string;
      systemKey: string | null;
      circleID: string | null;
      sortOrder: number;
    }>,
    eligibility: Eligibility,
  ): DisplayIconDto[] {
    const systemMap = new Map(
      eligibility.systemIcons.map((item) => [item.systemKey, item]),
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
          const icon = systemMap.get(selection.systemKey as SystemIconKeyDto);
          if (!icon) return null;

          return {
            id: selection.id,
            type: DisplayIconTypeDto.SYSTEM,
            title: icon.title,
            imageUrl: icon.imageUrl,
            fallbackIconName: icon.fallbackIconName,
            systemKey: icon.systemKey,
            recognitionCount: icon.recognitionCount,
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
