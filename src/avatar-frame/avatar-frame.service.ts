import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AvatarFrameErrorCode } from 'src/common/app-error-codes';
import { Prisma } from 'src/generated/prisma';
import { resolveEffectiveMembershipLevel } from 'src/membership/membership.catalog';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';

export type AvatarFrameOwnedSource =
  | {
      type: 'MEMBERSHIP';
      minimumVipLevel: number;
      expiresAt: Date | null;
    }
  | {
      type: 'ADMIN';
      grantId: string;
      expiresAt: Date | null;
    };

export interface AvatarFrameInventoryItem {
  id: string;
  key: string;
  name: string;
  description: string;
  imageUrl: string | null;
  minimumVipLevel: number | null;
  ownedSources: AvatarFrameOwnedSource[];
  availableUntil: Date | null;
  equipped: boolean;
}

export interface AvatarFrameInventory {
  equippedFrameId: string | null;
  items: AvatarFrameInventoryItem[];
}

export interface AvatarFramePublicAppearance {
  id: string;
  key: string;
  name: string;
  imageUrl: string | null;
}

export interface PublicUserAppearance {
  vipLevel: number;
  avatarFrame: AvatarFramePublicAppearance | null;
}

type MembershipState = {
  vipLevel: number;
  vipExpiresAt: Date | null;
};

type FrameGrantState = {
  id: string;
  frameID?: string;
  expiresAt: Date | null;
  revokedAt?: Date | null;
};

type FrameAssetState = {
  id: string;
  key: string;
  name: string;
  description: string;
  imageUrl: string | null;
  minimumVipLevel: number | null;
  isActive: boolean;
  sortOrder: number;
  grants?: FrameGrantState[];
};

export type AvatarFrameSelectionState = MembershipState & {
  id: string;
  selectedAvatarFrameID: string | null;
  selectedAvatarFrameExpiresAt: Date | null;
  selectedAvatarFrame: FrameAssetState | null;
  avatarFrameGrants: FrameGrantState[];
};

const ACTIVE_GRANT_WHERE = (userId: string, now: Date) =>
  ({
    userID: userId,
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  }) satisfies Prisma.UserAvatarFrameGrantWhereInput;

@Injectable()
export class AvatarFrameService {
  private readonly logger = new Logger(AvatarFrameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  toPublicAppearance(
    state: AvatarFrameSelectionState,
    now = new Date(),
  ): AvatarFramePublicAppearance | null {
    const frame = state.selectedAvatarFrame;
    if (
      !frame ||
      !state.selectedAvatarFrameID ||
      frame.id !== state.selectedAvatarFrameID ||
      !frame.isActive ||
      !this.isDeadlineActive(state.selectedAvatarFrameExpiresAt, now)
    ) {
      return null;
    }

    const currentSources = this.resolveSources(
      frame,
      state,
      state.avatarFrameGrants.filter(
        (grant) =>
          grant.frameID === undefined ||
          grant.frameID === state.selectedAvatarFrameID,
      ),
      now,
    );
    if (currentSources.length === 0) {
      return null;
    }

    return {
      id: frame.id,
      key: frame.key,
      name: frame.name,
      imageUrl: frame.imageUrl,
    };
  }

  async resolvePublicAppearances(
    userIds: string[],
    now = new Date(),
  ): Promise<Map<string, PublicUserAppearance>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) {
      return new Map();
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: uniqueUserIds } },
      select: {
        id: true,
        vipLevel: true,
        vipExpiresAt: true,
        selectedAvatarFrameID: true,
        selectedAvatarFrameExpiresAt: true,
        selectedAvatarFrame: {
          select: {
            id: true,
            key: true,
            name: true,
            description: true,
            imageUrl: true,
            minimumVipLevel: true,
            isActive: true,
            sortOrder: true,
          },
        },
      },
    });

    const selectedPairs = users.flatMap((user) =>
      user.selectedAvatarFrameID
        ? [
            {
              userID: user.id,
              frameID: user.selectedAvatarFrameID,
            },
          ]
        : [],
    );
    const grants =
      selectedPairs.length === 0
        ? []
        : await this.prisma.userAvatarFrameGrant.findMany({
            where: {
              revokedAt: null,
              AND: [
                { OR: selectedPairs },
                { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              ],
            },
            select: {
              id: true,
              userID: true,
              frameID: true,
              expiresAt: true,
              revokedAt: true,
            },
          });
    const selectedFrameByUser = new Map(
      users.map((user) => [user.id, user.selectedAvatarFrameID]),
    );
    const grantsByUser = new Map<string, FrameGrantState[]>();
    for (const grant of grants) {
      if (selectedFrameByUser.get(grant.userID) !== grant.frameID) {
        continue;
      }
      const userGrants = grantsByUser.get(grant.userID);
      if (userGrants) {
        userGrants.push(grant);
      } else {
        grantsByUser.set(grant.userID, [grant]);
      }
    }
    const appearanceById = new Map<string, PublicUserAppearance>();
    for (const user of users) {
      const state: AvatarFrameSelectionState = {
        ...user,
        avatarFrameGrants: grantsByUser.get(user.id) ?? [],
      };
      appearanceById.set(user.id, {
        vipLevel: resolveEffectiveMembershipLevel(user, now),
        avatarFrame: this.toPublicAppearance(state, now),
      });
    }

    return new Map(
      uniqueUserIds.flatMap((userId) => {
        const appearance = appearanceById.get(userId);
        return appearance ? [[userId, appearance] as const] : [];
      }),
    );
  }

  async getInventory(
    userId: string,
    now = new Date(),
  ): Promise<AvatarFrameInventory> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        vipLevel: true,
        vipExpiresAt: true,
        selectedAvatarFrameID: true,
        selectedAvatarFrameExpiresAt: true,
      },
    });
    if (!user) {
      this.throwUserNotFound();
    }

    const effectiveLevel = resolveEffectiveMembershipLevel(user, now);
    const membershipCondition =
      effectiveLevel > 0 ? [{ minimumVipLevel: { lte: effectiveLevel } }] : [];
    const assets = await this.prisma.avatarFrameAsset.findMany({
      where: {
        isActive: true,
        OR: [
          ...membershipCondition,
          { grants: { some: ACTIVE_GRANT_WHERE(userId, now) } },
        ],
      },
      include: {
        grants: {
          where: ACTIVE_GRANT_WHERE(userId, now),
          select: { id: true, expiresAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    const ownedItems = assets
      .filter((asset) => asset.isActive)
      .map((asset) => this.toInventoryItem(asset, user, now))
      .filter(
        (
          item,
        ): item is Omit<AvatarFrameInventoryItem, 'equipped'> & {
          equipped?: boolean;
        } => item !== null,
      );
    const selectionDeadlineActive = this.isDeadlineActive(
      user.selectedAvatarFrameExpiresAt,
      now,
    );
    const equippedFrameId =
      selectionDeadlineActive &&
      user.selectedAvatarFrameID &&
      ownedItems.some((item) => item.id === user.selectedAvatarFrameID)
        ? user.selectedAvatarFrameID
        : null;

    return {
      equippedFrameId,
      items: ownedItems.map((item) => ({
        ...item,
        equipped: item.id === equippedFrameId,
      })),
    };
  }

  async setEquipped(
    userId: string,
    frameId: string | null,
    now = new Date(),
  ): Promise<AvatarFrameInventory> {
    try {
      await runSerializableTransaction(this.prisma, async (tx) => {
        if (frameId === null) {
          await tx.user.update({
            where: { id: userId },
            data: {
              selectedAvatarFrameID: null,
              selectedAvatarFrameExpiresAt: null,
            },
          });
          return;
        }

        const [user, frame] = await Promise.all([
          tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              vipLevel: true,
              vipExpiresAt: true,
            },
          }),
          tx.avatarFrameAsset.findUnique({
            where: { id: frameId },
            include: {
              grants: {
                where: ACTIVE_GRANT_WHERE(userId, now),
                select: { id: true, expiresAt: true },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              },
            },
          }),
        ]);
        if (!user) {
          this.throwUserNotFound();
        }
        if (!frame) {
          throw new NotFoundException({
            message: 'Avatar frame asset not found',
            errorCode: AvatarFrameErrorCode.AssetNotFound,
          });
        }
        if (!frame.isActive) {
          throw new ConflictException({
            message: 'Avatar frame asset is inactive',
            errorCode: AvatarFrameErrorCode.AssetInactive,
          });
        }

        const sources = this.resolveSources(frame, user, frame.grants, now);
        if (sources.length === 0) {
          throw new ForbiddenException({
            message: 'Avatar frame is not currently owned',
            errorCode: AvatarFrameErrorCode.NotOwned,
          });
        }

        await tx.user.update({
          where: { id: userId },
          data: {
            selectedAvatarFrameID: frameId,
            selectedAvatarFrameExpiresAt: this.availableUntil(sources),
          },
        });
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2025') {
        this.throwUserNotFound();
      }
      throw error;
    }

    await this.publishAppearanceChanged(userId);
    return this.getInventory(userId, now);
  }

  async extendSelectionContinuityForMembershipChange(
    tx: Prisma.TransactionClient,
    previous: AvatarFrameSelectionState,
    nextMembership: MembershipState,
    now = new Date(),
  ): Promise<void> {
    const frame = previous.selectedAvatarFrame;
    const selectedFrameId = previous.selectedAvatarFrameID;
    if (
      !frame ||
      !selectedFrameId ||
      !frame.isActive ||
      !this.isDeadlineActive(previous.selectedAvatarFrameExpiresAt, now)
    ) {
      return;
    }

    const relevantGrants = previous.avatarFrameGrants.filter(
      (grant) =>
        grant.frameID === undefined || grant.frameID === selectedFrameId,
    );
    const previousSources = this.resolveSources(
      frame,
      previous,
      relevantGrants,
      now,
    );
    if (previousSources.length === 0) {
      return;
    }

    const nextSources = this.resolveSources(
      frame,
      nextMembership,
      relevantGrants,
      now,
    );
    if (nextSources.length === 0) {
      return;
    }

    const currentDeadline = previous.selectedAvatarFrameExpiresAt;
    const nextDeadline = this.availableUntil(nextSources);
    const extendsContinuity =
      currentDeadline !== null &&
      (nextDeadline === null ||
        nextDeadline.getTime() > currentDeadline.getTime());
    if (!extendsContinuity) {
      return;
    }

    await tx.user.update({
      where: { id: previous.id },
      data: { selectedAvatarFrameExpiresAt: nextDeadline },
    });
  }

  async recomputeSelectionContinuityInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    now = new Date(),
  ): Promise<void> {
    const state = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        vipLevel: true,
        vipExpiresAt: true,
        selectedAvatarFrameID: true,
        selectedAvatarFrameExpiresAt: true,
        selectedAvatarFrame: {
          select: {
            id: true,
            key: true,
            name: true,
            description: true,
            imageUrl: true,
            minimumVipLevel: true,
            isActive: true,
            sortOrder: true,
          },
        },
        avatarFrameGrants: {
          where: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: {
            id: true,
            frameID: true,
            expiresAt: true,
            revokedAt: true,
          },
        },
      },
    });
    if (!state) {
      this.throwUserNotFound();
    }
    if (!state.selectedAvatarFrameID) {
      return;
    }

    const frame = state.selectedAvatarFrame;
    if (
      !frame ||
      !frame.isActive ||
      !this.isDeadlineActive(state.selectedAvatarFrameExpiresAt, now)
    ) {
      await this.clearSelection(tx, userId);
      return;
    }

    const sources = this.resolveSources(
      frame,
      state,
      state.avatarFrameGrants.filter(
        (grant) => grant.frameID === state.selectedAvatarFrameID,
      ),
      now,
    );
    if (sources.length === 0) {
      await this.clearSelection(tx, userId);
      return;
    }

    const deadline = this.availableUntil(sources);
    if (this.sameDeadline(deadline, state.selectedAvatarFrameExpiresAt)) {
      return;
    }
    await tx.user.update({
      where: { id: userId },
      data: { selectedAvatarFrameExpiresAt: deadline },
    });
  }

  async publishAppearanceChanged(userId: string): Promise<void> {
    try {
      const invalidated = await this.realtime.invalidateUserHotCache(userId);
      if (!invalidated) {
        await this.realtime.invalidateUserHotCache(userId);
      }
    } catch {
      this.logger.warn(
        'Avatar frame cache invalidation failed after selection commit',
      );
    }

    try {
      await this.realtime.broadcastUserProfileSummary(userId);
    } catch {
      this.logger.warn(
        'Avatar frame profile broadcast failed after selection commit',
      );
    }
  }

  private toInventoryItem(
    asset: FrameAssetState,
    membership: MembershipState,
    now: Date,
  ): Omit<AvatarFrameInventoryItem, 'equipped'> | null {
    const sources = this.resolveSources(
      asset,
      membership,
      asset.grants ?? [],
      now,
    );
    if (sources.length === 0) {
      return null;
    }
    return {
      id: asset.id,
      key: asset.key,
      name: asset.name,
      description: asset.description,
      imageUrl: asset.imageUrl,
      minimumVipLevel: asset.minimumVipLevel,
      ownedSources: sources,
      availableUntil: this.availableUntil(sources),
    };
  }

  private resolveSources(
    asset: Pick<FrameAssetState, 'minimumVipLevel'>,
    membership: MembershipState,
    grants: FrameGrantState[],
    now: Date,
  ): AvatarFrameOwnedSource[] {
    const sources: AvatarFrameOwnedSource[] = [];
    const effectiveLevel = resolveEffectiveMembershipLevel(membership, now);
    if (
      asset.minimumVipLevel !== null &&
      effectiveLevel >= asset.minimumVipLevel
    ) {
      sources.push({
        type: 'MEMBERSHIP',
        minimumVipLevel: asset.minimumVipLevel,
        expiresAt: effectiveLevel >= 4 ? null : membership.vipExpiresAt,
      });
    }
    for (const grant of grants) {
      if (
        grant.revokedAt == null &&
        (grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime())
      ) {
        sources.push({
          type: 'ADMIN',
          grantId: grant.id,
          expiresAt: grant.expiresAt,
        });
      }
    }
    return sources;
  }

  private availableUntil(sources: AvatarFrameOwnedSource[]): Date | null {
    if (sources.some((source) => source.expiresAt === null)) {
      return null;
    }
    return new Date(
      Math.max(
        ...sources.map((source) => (source.expiresAt as Date).getTime()),
      ),
    );
  }

  private isDeadlineActive(deadline: Date | null, now: Date): boolean {
    return deadline === null || deadline.getTime() > now.getTime();
  }

  private sameDeadline(left: Date | null, right: Date | null): boolean {
    return (
      left === right ||
      (left !== null && right !== null && left.getTime() === right.getTime())
    );
  }

  private async clearSelection(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: {
        selectedAvatarFrameID: null,
        selectedAvatarFrameExpiresAt: null,
      },
    });
  }

  private throwUserNotFound(): never {
    throw new NotFoundException({
      message: 'User not found',
      errorCode: AvatarFrameErrorCode.UserNotFound,
    });
  }
}
