import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from 'src/generated/prisma';
import { CircleErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenimService } from 'src/openim/openim.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { circleApplicationLockKey } from 'src/circle-invitation/circle-application-lock';
import {
  CircleDetailDto,
  CircleDto,
  MyCircleDto,
  CreateCircleDto,
  ListCirclesQueryDto,
  MyCirclesQueryDto,
  SelectCircleIconDto,
  UploadCircleIconDto,
} from './dto/circle.dto';

const MAX_JOIN_TX_ATTEMPTS = 3;
// The SYSTEM icon catalogue grows with every icon ever shipped and is read
// whole by its endpoint, so cap it instead of letting table size decide the
// response size.
const MAX_AVAILABLE_ICON_ASSETS = 100;

@Injectable()
export class CircleService {
  private readonly logger = new Logger(CircleService.name);
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
    private readonly circleInvitationService: CircleInvitationService,
    private readonly config: ConfigService,
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
  }

  /**
   * Rejects an avatar URL not served from this application's own storage.
   * The circle avatar is rendered to every viewer of the circle, so an
   * off-origin URL would be a tracking / phishing vector. Skipped when MinIO
   * is unconfigured (upload disabled anyway).
   */
  private assertAvatarUrlIsSafe(avatarUrl: string | null | undefined): void {
    if (!this.minioPublicUrl || !avatarUrl) return;
    const prefix = this.minioPublicUrl.replace(/\/$/, '');
    if (avatarUrl !== prefix && !avatarUrl.startsWith(`${prefix}/`)) {
      throw new BadRequestException({
        message: "avatarUrl must be served from this application's storage",
        errorCode: CircleErrorCode.AvatarUrlInvalid,
      });
    }
  }

  async createCircle(
    userId: string,
    dto: CreateCircleDto,
  ): Promise<CircleDetailDto> {
    // VIP gate: only VIP users can create circles
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipLevel: true },
    });
    if (!user || user.vipLevel < 1) {
      throw new ForbiddenException({
        message: 'Only VIP users can create circles',
        errorCode: CircleErrorCode.VipRequired,
      });
    }

    this.assertAvatarUrlIsSafe(dto.avatarUrl);
    const categories = this.normalizeStringList(
      dto.categories ?? [],
      'category',
    );

    const circle = await this.prisma.$transaction(async (tx) => {
      const created = await tx.circle.create({
        data: {
          name: dto.name,
          categories,
          description: dto.description,
          avatarUrl: dto.avatarUrl ?? null,
          ownerID: userId,
          cities: dto.cities ?? [],
          rules: dto.rules ?? '',
          tags: dto.tags ?? [],
          joinVipRestriction: dto.joinVipRestriction ?? null,
          joinCreditRestriction: dto.joinCreditRestriction ?? null,
          joinFancyRestriction: dto.joinFancyRestriction ?? false,
          maxMembers: dto.maxMembers ?? null,
          memberCanPost: dto.memberCanPost ?? true,
          memberCount: 1,
        },
      });

      await tx.circleMember.create({
        data: {
          userID: userId,
          circleID: created.id,
          role: 'OWNER',
          status: 'ACTIVE',
        },
      });

      return created;
    });

    // Create bound OpenIM group (non-blocking — don't fail circle creation if IM is down)
    let groupID: string | null = null;

    try {
      await this.openimService.createGroup(circle.id, circle.name, userId, [
        userId,
      ]);
      await this.prisma.circle.update({
        where: { id: circle.id },
        data: { groupID: circle.id },
      });
      groupID = circle.id;
    } catch (error) {
      this.logger.warn(
        `Failed to create OpenIM group for circle ${circle.id}: ${error}`,
      );
    }

    return {
      ...this.toCircleDto(circle),
      groupID,
      myRole: 'OWNER',
      myStatus: 'ACTIVE',
    };
  }

  async listCircles(query: ListCirclesQueryDto): Promise<{
    items: CircleDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { deleted: false };
    if (query.city) {
      where.cities = { has: query.city };
    }

    const [circles, total] = await Promise.all([
      this.prisma.circle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.circle.count({ where }),
    ]);

    return {
      items: circles.map((c) => this.toCircleDto(c)),
      total,
      page,
      limit,
    };
  }

  async myCircles(
    userId: string,
    query: MyCirclesQueryDto,
  ): Promise<MyCircleDto[]> {
    const { tab } = query;

    if (tab === 'created') {
      const circles = await this.prisma.circle.findMany({
        where: { ownerID: userId, deleted: false },
        orderBy: { createdAt: 'desc' },
      });
      // 按定义 created === 自己是圈主。
      return circles.map((c) => ({ ...this.toCircleDto(c), myRole: 'OWNER' }));
    }

    const statusFilter = tab === 'joined' ? 'ACTIVE' : 'PENDING';

    const members = await this.prisma.circleMember.findMany({
      where: {
        userID: userId,
        status: statusFilter,
        ...(tab === 'joined' ? { role: { not: 'OWNER' } } : {}),
        circle: { deleted: false },
      },
      include: { circle: true },
      orderBy: { createdAt: 'desc' },
    });

    // 角色就在 membership 行上，一并返回，省掉客户端逐个拉详情。
    return members.map((m) => ({
      ...this.toCircleDto(m.circle),
      myRole: m.role,
    }));
  }

  async getCircleDetail(
    userId: string,
    circleId: string,
  ): Promise<CircleDetailDto> {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, deleted: false },
      include: {
        currentIconAsset: {
          select: {
            id: true,
            imageUrl: true,
          },
        },
      },
    });
    if (!circle)
      throw new NotFoundException({
        message: 'Circle not found',
        errorCode: CircleErrorCode.NotFound,
      });

    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: userId, circleID: circleId } },
    });

    const availableIconAssets = await this.prisma.iconAsset.findMany({
      where: {
        OR: [
          { sourceType: 'SYSTEM' },
          { sourceType: 'CIRCLE', circleID: circleId },
        ],
      },
      select: {
        id: true,
        name: true,
        imageUrl: true,
      },
      orderBy: [{ sourceType: 'asc' }, { createdAt: 'desc' }],
      take: MAX_AVAILABLE_ICON_ASSETS,
    });

    return {
      ...this.toCircleDto(circle),
      myRole: membership?.role ?? null,
      myStatus: membership?.status ?? null,
      availableIconAssets,
    };
  }

  async joinCircle(userId: string, circleId: string) {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, deleted: false },
    });
    if (!circle)
      throw new NotFoundException({
        message: 'Circle not found',
        errorCode: CircleErrorCode.NotFound,
      });

    if (circle.maxMembers != null && circle.memberCount >= circle.maxMembers) {
      throw new BadRequestException({
        message: 'Circle has reached its member limit',
        errorCode: CircleErrorCode.MemberLimit,
      });
    }

    await this.assertJoinRestrictions(userId, circle);

    // All joins are reviewed. The pair lock is shared with the member-invite
    // path so a direct join and an invitation cannot create two applications.
    let invitationId: string | null = null;
    for (let attempt = 1; attempt <= MAX_JOIN_TX_ATTEMPTS; attempt += 1) {
      try {
        invitationId = await this.prisma.$transaction(
          async (tx) => {
            const pairKey = circleApplicationLockKey(circleId, userId);
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

            const existing = await tx.circleMember.findUnique({
              where: {
                userID_circleID: { userID: userId, circleID: circleId },
              },
            });
            if (existing?.status === 'ACTIVE') {
              throw new ConflictException({
                message: 'Already a member',
                errorCode: CircleErrorCode.AlreadyMember,
              });
            }

            if (existing?.status === 'PENDING') {
              await tx.circleMember.update({
                where: { id: existing.id },
                data: { status: 'PENDING', role: 'MEMBER' },
              });
            } else {
              await tx.circleMember.create({
                data: {
                  userID: userId,
                  circleID: circleId,
                  role: 'MEMBER',
                  status: 'PENDING',
                },
              });
            }

            // 已有进行中的担保单（例如成员先邀请过）则复用，不重复建。
            const existingInvitation = await tx.circleInvitation.findFirst({
              where: {
                circleID: circleId,
                applicantID: userId,
                status: 'PENDING',
              },
              select: { id: true },
            });
            if (!existingInvitation) {
              const created = await tx.circleInvitation.create({
                data: {
                  circleID: circleId,
                  applicantID: userId,
                  inviterID: userId,
                },
                select: { id: true },
              });
              return created.id;
            }
            return existingInvitation.id;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        break;
      } catch (error) {
        if (
          this.isRetryableTransactionError(error) &&
          attempt < MAX_JOIN_TX_ATTEMPTS
        ) {
          this.logger.warn(
            `Retrying circle join after serialization conflict (attempt ${attempt})`,
          );
          continue;
        }
        // A concurrent operation should be retried under the pair lock. A
        // remaining unique violation is surfaced as a structured conflict.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException({
            message: 'Already a member or a join request is already pending',
            errorCode: CircleErrorCode.AlreadyMemberOrPending,
          });
        }
        throw error;
      }
    }

    if (!invitationId) {
      throw new ConflictException({
        message: 'Unable to create a join request',
        errorCode: CircleErrorCode.RequestPending,
      });
    }
    return this.circleInvitationService.getInvitationForViewer(
      userId,
      invitationId,
    );
  }

  async leaveCircle(userId: string, circleId: string): Promise<void> {
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: userId, circleID: circleId } },
    });
    if (!membership)
      throw new NotFoundException({
        message: 'Not a member',
        errorCode: CircleErrorCode.NotMember,
      });
    if (membership.role === 'OWNER') {
      throw new ForbiddenException({
        message: 'Owner cannot leave — transfer ownership first',
        errorCode: CircleErrorCode.OwnerCannotLeave,
      });
    }

    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { groupID: true },
    });

    await this.prisma.$transaction(async (tx) => {
      const pairKey = circleApplicationLockKey(circleId, userId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

      const lockedMembership = await tx.circleMember.findUnique({
        where: { userID_circleID: { userID: userId, circleID: circleId } },
      });
      if (!lockedMembership) {
        throw new NotFoundException({
          message: 'Not a member',
          errorCode: CircleErrorCode.NotMember,
        });
      }
      if (lockedMembership.role === 'OWNER') {
        throw new ForbiddenException({
          message: 'Owner cannot leave — transfer ownership first',
          errorCode: CircleErrorCode.OwnerCannotLeave,
        });
      }

      const wasActive = lockedMembership.status === 'ACTIVE';

      if (!wasActive) {
        await tx.circleInvitation.updateMany({
          where: {
            circleID: circleId,
            applicantID: userId,
            status: 'PENDING',
          },
          data: { status: 'CANCELLED' },
        });
      }

      await tx.userDisplayIcon.deleteMany({
        where: { userID: userId, circleID: circleId },
      });
      await tx.circleMember.delete({ where: { id: lockedMembership.id } });

      if (wasActive) {
        await tx.circle.update({
          where: { id: circleId },
          data: { memberCount: { decrement: 1 } },
        });
      }
    });

    // Remove from OpenIM group
    if (circle?.groupID) {
      try {
        await this.openimService.removeGroupMember(circle.groupID, userId);
      } catch (error) {
        this.logger.warn(
          `Failed to remove user ${userId} from OpenIM group ${circle.groupID}: ${error}`,
        );
      }
    }
  }

  async uploadCircleIcon(
    userId: string,
    circleId: string,
    dto: UploadCircleIconDto,
  ) {
    await this.assertOwner(userId, circleId);
    // The icon is equippable as a badge and rendered to every plaza viewer, so
    // it is at least as exposed as the avatar and gets the same origin guard.
    this.assertAvatarUrlIsSafe(dto.imageUrl);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.iconAsset.create({
        data: {
          name: dto.name?.trim() || '圈子图标',
          sourceType: 'CIRCLE',
          imageUrl: dto.imageUrl,
          circleID: circleId,
          createdByID: userId,
        },
      });

      await tx.circle.update({
        where: { id: circleId },
        data: { currentIconAssetID: created.id },
      });

      await tx.iconAsset.deleteMany({
        where: {
          sourceType: 'CIRCLE',
          circleID: circleId,
          id: { not: created.id },
        },
      });

      return created;
    });
  }

  async selectCircleIcon(
    userId: string,
    circleId: string,
    dto: SelectCircleIconDto,
  ): Promise<void> {
    await this.assertOwner(userId, circleId);

    const asset = await this.prisma.iconAsset.findFirst({
      where: {
        id: dto.iconAssetId,
        OR: [
          { sourceType: 'SYSTEM' },
          { sourceType: 'CIRCLE', circleID: circleId },
        ],
      },
      select: { id: true },
    });

    if (!asset) {
      throw new NotFoundException({
        message: 'Circle icon asset not found',
        errorCode: CircleErrorCode.IconAssetNotFound,
      });
    }

    await this.prisma.circle.update({
      where: { id: circleId },
      data: { currentIconAssetID: asset.id },
    });
  }

  async setCircleCover(
    userId: string,
    circleId: string,
    cover: string,
  ): Promise<void> {
    await this.assertOwner(userId, circleId);
    // Covers are uploaded to this app's storage; reject arbitrary URLs.
    this.assertAvatarUrlIsSafe(cover);
    await this.prisma.circle.update({
      where: { id: circleId },
      data: { cover },
    });
  }

  async setCircleAvatar(
    userId: string,
    circleId: string,
    avatarUrl: string,
  ): Promise<void> {
    await this.assertOwner(userId, circleId);
    this.assertAvatarUrlIsSafe(avatarUrl);
    await this.prisma.circle.update({
      where: { id: circleId },
      data: { avatarUrl },
    });
  }

  private async assertJoinRestrictions(
    userId: string,
    circle: {
      joinVipRestriction: number | null;
      joinCreditRestriction: number | null;
      joinFancyRestriction: boolean;
    },
  ): Promise<void> {
    if (
      circle.joinVipRestriction == null &&
      circle.joinCreditRestriction == null &&
      !circle.joinFancyRestriction
    ) {
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipLevel: true, creditScore: true, fancyNumber: true },
    });
    if (!user) {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: CircleErrorCode.UserNotFound,
      });
    }

    if (
      circle.joinVipRestriction != null &&
      user.vipLevel < circle.joinVipRestriction
    ) {
      throw new ForbiddenException({
        message: `VIP ${circle.joinVipRestriction}+ is required to join this circle`,
        errorCode: CircleErrorCode.JoinVipRequired,
      });
    }
    if (
      circle.joinCreditRestriction != null &&
      user.creditScore < circle.joinCreditRestriction
    ) {
      throw new ForbiddenException({
        message: `Credit score ${circle.joinCreditRestriction}+ is required to join this circle`,
        errorCode: CircleErrorCode.JoinCreditRequired,
      });
    }
    if (circle.joinFancyRestriction && !user.fancyNumber) {
      throw new ForbiddenException({
        message: 'A fancy number is required to join this circle',
        errorCode: CircleErrorCode.JoinFancyNumberRequired,
      });
    }
  }

  private normalizeStringList(values: string[], label: string): string[] {
    const normalized = values.map((value) => value.trim());
    if (normalized.some((value) => value.length === 0)) {
      throw new BadRequestException({
        message: `${label} must not be blank`,
        errorCode: CircleErrorCode.ListItemBlank,
      });
    }
    if (new Set(normalized).size !== normalized.length) {
      throw new BadRequestException({
        message: `${label} must be unique`,
        errorCode: CircleErrorCode.ListItemDuplicate,
      });
    }
    return normalized;
  }

  private isRetryableTransactionError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }

  private async assertOwner(userId: string, circleId: string) {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, deleted: false },
      select: {
        id: true,
        ownerID: true,
      },
    });

    if (!circle) {
      throw new NotFoundException({
        message: 'Circle not found',
        errorCode: CircleErrorCode.NotFound,
      });
    }
    if (circle.ownerID !== userId) {
      throw new ForbiddenException({
        message: 'Only the owner can manage circle icons',
        errorCode: CircleErrorCode.IconOwnerOnly,
      });
    }

    return circle;
  }

  private toCircleDto(circle: any): CircleDto {
    return {
      id: circle.id,
      name: circle.name,
      description: circle.description,
      avatarUrl: circle.avatarUrl,
      ownerID: circle.ownerID,
      currentIconAssetID: circle.currentIconAssetID ?? null,
      currentIconUrl: circle.currentIconAsset?.imageUrl ?? null,
      cover: circle.cover ?? null,
      cities: circle.cities,
      categories: circle.categories,
      rules: circle.rules,
      tags: circle.tags,
      joinVipRestriction: circle.joinVipRestriction,
      joinCreditRestriction: circle.joinCreditRestriction,
      joinFancyRestriction: circle.joinFancyRestriction,
      maxMembers: circle.maxMembers,
      memberCanPost: circle.memberCanPost,
      groupID: circle.groupID,
      memberCount: circle.memberCount,
      postCount: circle.postCount,
      createdAt: circle.createdAt.toISOString(),
    };
  }
}
