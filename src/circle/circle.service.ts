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
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenimService } from 'src/openim/openim.service';
import {
  CircleDetailDto,
  CircleDto,
  CreateCircleDto,
  ListCirclesQueryDto,
  MyCirclesQueryDto,
  SelectCircleIconDto,
  UploadCircleIconDto,
} from './dto/circle.dto';

const MAX_JOIN_TX_ATTEMPTS = 3;

@Injectable()
export class CircleService {
  private readonly logger = new Logger(CircleService.name);
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
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
      throw new BadRequestException(
        "avatarUrl must be served from this application's storage",
      );
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
      throw new ForbiddenException('Only VIP users can create circles');
    }

    this.assertAvatarUrlIsSafe(dto.avatarUrl);

    const circle = await this.prisma.$transaction(async (tx) => {
      const created = await tx.circle.create({
        data: {
          name: dto.name,
          categories: dto.categories ?? [],
          description: dto.description,
          avatarUrl: dto.avatarUrl ?? null,
          ownerID: userId,
          cities: dto.cities ?? [],
          rules: dto.rules ?? '',
          tags: dto.tags ?? [],
          isPublic: dto.isPublic ?? true,
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
  ): Promise<CircleDto[]> {
    const { tab } = query;

    if (tab === 'created') {
      const circles = await this.prisma.circle.findMany({
        where: { ownerID: userId, deleted: false },
        orderBy: { createdAt: 'desc' },
      });
      return circles.map((c) => this.toCircleDto(c));
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

    return members.map((m) => this.toCircleDto(m.circle));
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
    if (!circle) throw new NotFoundException('Circle not found');

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
    });

    return {
      ...this.toCircleDto(circle),
      myRole: membership?.role ?? null,
      myStatus: membership?.status ?? null,
      availableIconAssets,
    };
  }

  async joinCircle(userId: string, circleId: string): Promise<void> {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, deleted: false },
    });
    if (!circle) throw new NotFoundException('Circle not found');

    if (circle.maxMembers != null && circle.memberCount >= circle.maxMembers) {
      throw new BadRequestException('Circle has reached its member limit');
    }

    await this.assertJoinRestrictions(userId, circle);

    const existing = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: userId, circleID: circleId } },
    });
    if (existing) {
      if (existing.status === 'ACTIVE') {
        throw new ConflictException('Already a member');
      }
      if (existing.status === 'PENDING') {
        throw new ConflictException('Request already pending');
      }
    }

    const status = circle.isPublic ? 'ACTIVE' : 'PENDING';

    for (let attempt = 1; attempt <= MAX_JOIN_TX_ATTEMPTS; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const currentCircle = await tx.circle.findUnique({
              where: { id: circleId },
              select: { maxMembers: true, memberCount: true },
            });
            if (
              status === 'ACTIVE' &&
              currentCircle &&
              currentCircle.maxMembers != null &&
              currentCircle.memberCount >= currentCircle.maxMembers
            ) {
              throw new BadRequestException(
                'Circle has reached its member limit',
              );
            }

            if (existing) {
              await tx.circleMember.update({
                where: { id: existing.id },
                data: { status, role: 'MEMBER' },
              });
            } else {
              await tx.circleMember.create({
                data: {
                  userID: userId,
                  circleID: circleId,
                  role: 'MEMBER',
                  status,
                },
              });
            }

            if (status === 'ACTIVE') {
              await tx.circle.update({
                where: { id: circleId },
                data: { memberCount: { increment: 1 } },
              });
            }
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
        // A concurrent join wins the race between the pre-check and the
        // create — surface a clean conflict instead of a leaked P2002.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            'Already a member or a join request is already pending',
          );
        }
        throw error;
      }
    }

    // Add to OpenIM group if auto-joined
    if (status === 'ACTIVE' && circle.groupID) {
      try {
        await this.openimService.addGroupMembers(circle.groupID, [userId]);
      } catch (error) {
        this.logger.warn(
          `Failed to add user ${userId} to OpenIM group ${circle.groupID}: ${error}`,
        );
      }
    }
  }

  async leaveCircle(userId: string, circleId: string): Promise<void> {
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: userId, circleID: circleId } },
    });
    if (!membership) throw new NotFoundException('Not a member');
    if (membership.role === 'OWNER') {
      throw new ForbiddenException(
        'Owner cannot leave — transfer ownership first',
      );
    }

    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { groupID: true },
    });

    await this.prisma.$transaction(async (tx) => {
      const wasActive = membership.status === 'ACTIVE';

      await tx.userDisplayIcon.deleteMany({
        where: { userID: userId, circleID: circleId },
      });
      await tx.circleMember.delete({ where: { id: membership.id } });

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

    return this.prisma.iconAsset.create({
      data: {
        name: dto.name?.trim() || '圈子图标',
        sourceType: 'CIRCLE',
        imageUrl: dto.imageUrl,
        circleID: circleId,
        createdByID: userId,
      },
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
      throw new NotFoundException('Circle icon asset not found');
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
      throw new NotFoundException('User not found');
    }

    if (
      circle.joinVipRestriction != null &&
      user.vipLevel < circle.joinVipRestriction
    ) {
      throw new ForbiddenException(
        `VIP ${circle.joinVipRestriction}+ is required to join this circle`,
      );
    }
    if (
      circle.joinCreditRestriction != null &&
      user.creditScore < circle.joinCreditRestriction
    ) {
      throw new ForbiddenException(
        `Credit score ${circle.joinCreditRestriction}+ is required to join this circle`,
      );
    }
    if (circle.joinFancyRestriction && !user.fancyNumber) {
      throw new ForbiddenException(
        'A fancy number is required to join this circle',
      );
    }
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
      throw new NotFoundException('Circle not found');
    }
    if (circle.ownerID !== userId) {
      throw new ForbiddenException('Only the owner can manage circle icons');
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
      isPublic: circle.isPublic,
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
