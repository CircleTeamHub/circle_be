import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { AvatarFrameErrorCode } from 'src/common/app-error-codes';
import { Prisma } from 'src/generated/prisma';
import { AdminAuditService } from 'src/moderation/admin-audit.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';
import {
  decodeFeedCursor,
  encodeFeedCursor,
  feedCursorWhere,
} from 'src/utils/feed-cursor';
import { AvatarFrameService } from './avatar-frame.service';
import {
  CreateAvatarFrameGrantDto,
  RevokeAvatarFrameGrantDto,
} from './dto/avatar-frame-admin.dto';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';

type GrantRow = {
  id: string;
  userID: string;
  frameID: string;
  operatorUserID: string;
  idempotencyKey: string;
  reason: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByUserID: string | null;
  revokeReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  frame?: {
    id: string;
    key: string;
    name: string;
    imageUrl: string | null;
  };
};

type CanonicalGrantInput = {
  frameId: string;
  expiresAt: Date | null;
  reason: string;
  idempotencyKey: string;
};

type AvatarFrameAdminAuditContext = {
  ip?: string | null;
  userAgent?: string | null;
};

type GrantHistoryQuery = {
  cursor?: string;
  limit?: number;
};

const ADMIN_GRANT_SELECT = {
  id: true,
  userID: true,
  frameID: true,
  operatorUserID: true,
  idempotencyKey: true,
  reason: true,
  expiresAt: true,
  revokedAt: true,
  revokedByUserID: true,
  revokeReason: true,
  createdAt: true,
  updatedAt: true,
  frame: {
    select: {
      id: true,
      key: true,
      name: true,
      imageUrl: true,
    },
  },
} as const;

@Injectable()
export class AvatarFrameAdminService {
  private readonly logger = new Logger(AvatarFrameAdminService.name);
  private readonly loggingConfig = createLoggingConfig();
  constructor(
    private readonly prisma: PrismaService,
    private readonly avatarFrames: AvatarFrameService,
    private readonly audit: AdminAuditService,
  ) {}

  async listAssets() {
    const assets = await this.prisma.avatarFrameAsset.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        imageUrl: true,
        minimumVipLevel: true,
        sortOrder: true,
      },
    });
    return assets.map((asset) => ({
      id: asset.id,
      key: asset.key,
      name: asset.name,
      description: asset.description,
      imageUrl: asset.imageUrl,
      minimumVipLevel: asset.minimumVipLevel,
      sortOrder: asset.sortOrder,
    }));
  }

  async getUserInventory(
    userId: string,
    query: GrantHistoryQuery = {},
    now = new Date(),
  ) {
    const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 50)));
    const cursor = query.cursor
      ? decodeFeedCursor(query.cursor, AvatarFrameErrorCode.InvalidCursor)
      : null;
    const inventory = await this.avatarFrames.getInventory(userId, now);
    const grantRows = await this.prisma.userAvatarFrameGrant.findMany({
      where: {
        userID: userId,
        ...(cursor ? feedCursorWhere(cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: ADMIN_GRANT_SELECT,
    });
    const hasMore = grantRows.length > limit;
    const grants = grantRows.slice(0, limit);
    const lastGrant = grants[grants.length - 1];
    const equippedFrame =
      inventory.items.find((item) => item.id === inventory.equippedFrameId) ??
      null;

    return {
      userId,
      equippedFrameId: inventory.equippedFrameId,
      equippedFrameExpiresAt: equippedFrame?.availableUntil ?? null,
      equippedFrame,
      items: inventory.items,
      grants: {
        items: grants.map((grant) => this.toGrantView(grant, now)),
        limit,
        hasMore,
        nextCursor:
          hasMore && lastGrant
            ? encodeFeedCursor(lastGrant.createdAt, lastGrant.id)
            : null,
      },
    };
  }

  async grant(
    operatorUserId: string,
    targetUserId: string,
    dto: CreateAvatarFrameGrantDto,
    auditContext: AvatarFrameAdminAuditContext = {},
  ) {
    const input = this.canonicalizeGrant(dto);
    const strictAuditContext = this.sanitizeAuditContext(auditContext);
    let result: { created: boolean; grant: GrantRow };

    try {
      result = await runSerializableTransaction(this.prisma, async (tx) => {
        const replay = await tx.userAvatarFrameGrant.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (replay) {
          return {
            created: false,
            grant: this.replayGrantOrThrow(
              replay,
              operatorUserId,
              targetUserId,
              input,
            ),
          };
        }

        await this.assertUsersExist(tx, operatorUserId, targetUserId);
        const asset = await tx.avatarFrameAsset.findUnique({
          where: { id: input.frameId },
        });
        if (!asset) {
          throw new NotFoundException({
            message: 'Avatar frame asset not found',
            errorCode: AvatarFrameErrorCode.AssetNotFound,
          });
        }
        if (!asset.isActive) {
          throw new ConflictException({
            message: 'Avatar frame asset is inactive',
            errorCode: AvatarFrameErrorCode.AssetInactive,
          });
        }

        const transactionNow = new Date();
        this.assertFutureExpiry(input.expiresAt, transactionNow);
        const created = await tx.userAvatarFrameGrant.create({
          data: {
            userID: targetUserId,
            frameID: input.frameId,
            operatorUserID: operatorUserId,
            idempotencyKey: input.idempotencyKey,
            reason: input.reason,
            expiresAt: input.expiresAt,
          },
        });

        await this.audit.recordStrict(tx, {
          actorID: operatorUserId,
          action: 'avatar_frame_grant_created',
          entityType: 'UserAvatarFrameGrant',
          entityID: created.id,
          before: null,
          after: this.auditSnapshot(created),
          reason: input.reason,
          ...strictAuditContext,
        });
        await this.avatarFrames.recomputeSelectionContinuityInTransaction(
          tx,
          targetUserId,
          transactionNow,
        );
        return { created: true, grant: created };
      });
    } catch (error) {
      if (prismaErrorCode(error) !== 'P2002') {
        throw error;
      }
      const replay = await this.prisma.userAvatarFrameGrant.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!replay) {
        throw error;
      }
      result = {
        created: false,
        grant: this.replayGrantOrThrow(
          replay,
          operatorUserId,
          targetUserId,
          input,
        ),
      };
    }

    if (result.created) {
      await this.avatarFrames.publishAppearanceChanged(targetUserId);
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'avatar_frame_granted',
        actorId: operatorUserId,
        targetId: targetUserId,
        result: 'success',
        entityType: 'avatar_frame_grant',
        entityId: result.grant.id,
      });
    }
    return {
      replayed: !result.created,
      grant: this.toGrantView(result.grant, new Date()),
    };
  }

  async revoke(
    operatorUserId: string,
    grantId: string,
    dto: RevokeAvatarFrameGrantDto,
    auditContext: AvatarFrameAdminAuditContext = {},
  ) {
    const reason = this.canonicalizeReason(dto.reason);
    const strictAuditContext = this.sanitizeAuditContext(auditContext);
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const existing = await tx.userAvatarFrameGrant.findUnique({
        where: { id: grantId },
      });
      if (!existing) {
        throw new NotFoundException({
          message: 'Avatar frame grant not found',
          errorCode: AvatarFrameErrorCode.GrantNotFound,
        });
      }
      if (existing.revokedAt) {
        if (
          existing.revokedByUserID === operatorUserId &&
          existing.revokeReason === reason
        ) {
          return { changed: false, grant: existing };
        }
        throw new ConflictException({
          message: 'Avatar frame grant is already revoked',
          errorCode: AvatarFrameErrorCode.AlreadyRevoked,
        });
      }

      await this.assertUsersExist(tx, operatorUserId);
      const transactionNow = new Date();
      const updated = await tx.userAvatarFrameGrant.update({
        where: { id: grantId },
        data: {
          revokedAt: transactionNow,
          revokedByUserID: operatorUserId,
          revokeReason: reason,
        },
      });
      await this.audit.recordStrict(tx, {
        actorID: operatorUserId,
        action: 'avatar_frame_grant_revoked',
        entityType: 'UserAvatarFrameGrant',
        entityID: grantId,
        before: this.auditSnapshot(existing),
        after: this.auditSnapshot(updated),
        reason,
        ...strictAuditContext,
      });
      await this.avatarFrames.recomputeSelectionContinuityInTransaction(
        tx,
        existing.userID,
        transactionNow,
      );
      return { changed: true, grant: updated };
    });

    if (result.changed) {
      await this.avatarFrames.publishAppearanceChanged(result.grant.userID);
    }
    return {
      replayed: !result.changed,
      grant: this.toGrantView(result.grant, new Date()),
    };
  }

  private canonicalizeGrant(
    dto: CreateAvatarFrameGrantDto,
  ): CanonicalGrantInput {
    const expiresAt =
      dto.expiresAt == null ? null : new Date(Date.parse(dto.expiresAt));
    if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
      this.throwInvalidExpiry();
    }
    return {
      frameId: dto.frameId,
      expiresAt,
      reason: this.canonicalizeReason(dto.reason),
      idempotencyKey: dto.idempotencyKey,
    };
  }

  private canonicalizeReason(reason: string): string {
    const canonical = typeof reason === 'string' ? reason.trim() : '';
    if (canonical.length === 0 || canonical.length > 500) {
      throw new BadRequestException({
        message: 'A reason between 1 and 500 characters is required',
        errorCode: AvatarFrameErrorCode.InvalidReason,
      });
    }
    return canonical;
  }

  private assertFutureExpiry(expiresAt: Date | null, now: Date): void {
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      this.throwInvalidExpiry();
    }
  }

  private throwInvalidExpiry(): never {
    throw new BadRequestException({
      message: 'Avatar frame grant expiry must be in the future',
      errorCode: AvatarFrameErrorCode.InvalidExpiry,
    });
  }

  private async assertUsersExist(
    tx: Prisma.TransactionClient,
    operatorUserId: string,
    targetUserId?: string,
  ): Promise<void> {
    const ids = [...new Set([operatorUserId, targetUserId].filter(Boolean))] as
      | [string]
      | [string, string];
    const users = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const found = new Set(users.map((user) => user.id));
    if (targetUserId && !found.has(targetUserId)) {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: AvatarFrameErrorCode.UserNotFound,
      });
    }
    if (!found.has(operatorUserId)) {
      throw new NotFoundException({
        message: 'Operator user not found',
        errorCode: AvatarFrameErrorCode.OperatorNotFound,
      });
    }
  }

  private replayGrantOrThrow(
    grant: GrantRow,
    operatorUserId: string,
    targetUserId: string,
    input: CanonicalGrantInput,
  ): GrantRow {
    if (
      grant.operatorUserID !== operatorUserId ||
      grant.userID !== targetUserId ||
      grant.frameID !== input.frameId ||
      grant.reason !== input.reason ||
      !this.sameDeadline(grant.expiresAt, input.expiresAt)
    ) {
      throw new ConflictException({
        message: 'Idempotency key was already used for another request',
        errorCode: AvatarFrameErrorCode.IdempotencyConflict,
      });
    }
    return grant;
  }

  private sameDeadline(left: Date | null, right: Date | null): boolean {
    return (
      left === right ||
      (left !== null && right !== null && left.getTime() === right.getTime())
    );
  }

  private toGrantView(grant: GrantRow, now: Date) {
    let status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' = 'ACTIVE';
    if (grant.revokedAt !== null) {
      status = 'REVOKED';
    } else if (
      grant.expiresAt !== null &&
      grant.expiresAt.getTime() <= now.getTime()
    ) {
      status = 'EXPIRED';
    }
    return {
      id: grant.id,
      userId: grant.userID,
      frameId: grant.frameID,
      frame: grant.frame,
      operatorUserId: grant.operatorUserID,
      idempotencyKey: grant.idempotencyKey,
      reason: grant.reason,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      revokedByUserId: grant.revokedByUserID,
      revokeReason: grant.revokeReason,
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
      status,
    };
  }

  private auditSnapshot(grant: GrantRow): Record<string, unknown> {
    return {
      id: grant.id,
      userId: grant.userID,
      frameId: grant.frameID,
      operatorUserId: grant.operatorUserID,
      idempotencyKey: grant.idempotencyKey,
      reason: grant.reason,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      revokedAt: grant.revokedAt?.toISOString() ?? null,
      revokedByUserId: grant.revokedByUserID,
      revokeReason: grant.revokeReason,
    };
  }

  private sanitizeAuditContext(
    context: AvatarFrameAdminAuditContext,
  ): Required<AvatarFrameAdminAuditContext> {
    return {
      ip: context.ip?.slice(0, 64) ?? null,
      userAgent: context.userAgent?.slice(0, 256) ?? null,
    };
  }
}
