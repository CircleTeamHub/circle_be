import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CircleErrorCode,
  MembershipErrorCode,
} from 'src/common/app-error-codes';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';
import { CircleAdmissionPolicy } from './circle-admission-policy';
import { CIRCLE_CREATE_LIMIT } from './circle-limits';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { CircleMemberLockService } from './circle-member-lock';
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

// The SYSTEM icon catalogue grows with every icon ever shipped and is read
// whole by its endpoint, so cap it instead of letting table size decide the
// response size.
const MAX_AVAILABLE_ICON_ASSETS = 100;
const MY_CIRCLES_DEFAULT_LIMIT = 100;

@Injectable()
export class CircleService {
  private readonly logger = new Logger(CircleService.name);
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleInvitationService: CircleInvitationService,
    private readonly config: ConfigService,
    private readonly membershipPolicy: MembershipPolicyService,
    private readonly admissionPolicy: CircleAdmissionPolicy,
    private readonly memberLock: CircleMemberLockService,
    private readonly chatCircleSync: ChatCircleSyncService,
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
    this.assertAvatarUrlIsSafe(dto.avatarUrl);
    const categories = this.normalizeStringList(
      dto.categories ?? [],
      'category',
    );

    const circle = await this.prisma.$transaction(async (tx) => {
      await this.membershipPolicy.lockUsers(tx, [userId]);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { vipLevel: true, vipExpiresAt: true },
      });
      if (!user) {
        throw new NotFoundException({
          message: 'User not found',
          errorCode: CircleErrorCode.UserNotFound,
        });
      }

      const policy = await this.membershipPolicy.resolveEntitlement(
        user,
        tx,
        new Date(),
        // Serialize the rollout-floor read against program enablement so this
        // quota decision cannot commit under an obsolete entitlement floor.
        { lockForWrite: true },
      );

      // 非会员（有效档 0：普通 / 已过期）不能建圈。resolveEntitlement 已应用 staged-rollout
      // floor —— rollout 关闭期 level ≥ 2、此处不触发；仅 enforcement 开启且用户确为普通/过期
      // 时拒绝，兑现「普通用户不可建群」的会员契约（旧实现即拒非 VIP，本次收口时漏补回）。
      if (policy.level === 0) {
        throw new ForbiddenException({
          message: 'Membership is required to create a circle',
          errorCode: CircleErrorCode.VipRequired,
        });
      }

      // 建圈写的是 OWNER 成员行，不占「已加入圈子」额度，所以必须有独立上限：
      // 否则任何有效会员都能无限建圈，而每个圈子还会连带创建一个 OpenIM 群。
      // 在上面的 per-user 锁下统计，并发建圈不会越过上限。
      const ownedCircles = await tx.circle.count({
        where: { ownerID: userId, deleted: false },
      });
      if (ownedCircles >= CIRCLE_CREATE_LIMIT) {
        throw new ForbiddenException({
          message: 'Created circle limit reached',
          errorCode: CircleErrorCode.CreateLimitReached,
          limit: CIRCLE_CREATE_LIMIT,
          details: { limit: CIRCLE_CREATE_LIMIT },
        });
      }

      const capacity = policy.tier.quotas.groupMembers.actual;
      const maxMembers = dto.maxMembers ?? capacity;
      if (maxMembers > capacity) {
        throw new ForbiddenException({
          message: 'Requested circle capacity exceeds membership entitlement',
          errorCode: MembershipErrorCode.GroupMemberCapacityExceeded,
        });
      }
      const joinVipRestriction =
        this.admissionPolicy.normalizeCreatorVipRestriction(
          dto.joinVipRestriction,
          policy.level,
        );

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
          joinVipRestriction,
          joinCreditRestriction: dto.joinCreditRestriction ?? null,
          joinFancyRestriction: dto.joinFancyRestriction ?? false,
          maxMembers,
          memberCanPost: dto.memberCanPost ?? true,
          memberCount: 1,
        },
      });

      await this.memberLock.lock(tx, created.id, [userId]);
      await tx.circleMember.create({
        data: {
          userID: userId,
          circleID: created.id,
          role: 'OWNER',
          status: 'ACTIVE',
        },
      });

      // groupID 列保留(历史引用/群扩容等按它寻址),恒等于 circle.id;
      // OpenIM 群不再创建 —— 聊天会话由下方 chatCircleSync 负责。
      //
      // 必须留在事务里:放到事务外的话,这一步失败会留下一个已提交、带 OWNER
      // 成员、groupID 却为 null 的圈子,而请求已经报错返回 —— 用户重试又要吃掉
      // 一个 CIRCLE_CREATE_LIMIT 名额(配额按 deleted:false 计数,这个残圈算数)。
      await tx.circle.update({
        where: { id: created.id },
        data: { groupID: created.id },
      });

      return created;
    });

    const groupID: string | null = circle.id;

    // 自研聊天:建圈即建群会话(尽力而为;失败由每分钟对账兜底,不阻塞建圈)。
    void this.chatCircleSync.ensureCircleConversation(circle.id).catch((e) => {
      this.logger.warn(
        `chat conversation sync failed for circle ${circle.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });

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
    const limit = query.limit ?? (query.cursor ? 50 : MY_CIRCLES_DEFAULT_LIMIT);

    if (tab === 'created') {
      const baseWhere: Prisma.CircleWhereInput = {
        ownerID: userId,
        deleted: false,
      };
      const anchor = query.cursor
        ? await this.prisma.circle.findFirst({
            where: { ...baseWhere, id: query.cursor },
            select: { id: true, createdAt: true },
          })
        : null;
      if (query.cursor && !anchor) {
        throw new BadRequestException({
          message: 'Invalid circle cursor',
          errorCode: CircleErrorCode.InvalidCursor,
        });
      }

      const circles = await this.prisma.circle.findMany({
        where: anchor
          ? {
              ...baseWhere,
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                {
                  createdAt: anchor.createdAt,
                  id: { lt: anchor.id },
                },
              ],
            }
          : baseWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      // 按定义 created === 自己是圈主。
      return circles.map((c) => ({ ...this.toCircleDto(c), myRole: 'OWNER' }));
    }

    const statusFilter = tab === 'joined' ? 'ACTIVE' : 'PENDING';
    const baseWhere: Prisma.CircleMemberWhereInput = {
      userID: userId,
      status: statusFilter,
      ...(tab === 'joined' ? { role: { not: 'OWNER' } } : {}),
      circle: { deleted: false },
    };
    const anchor = query.cursor
      ? await this.prisma.circleMember.findFirst({
          where: { ...baseWhere, circleID: query.cursor },
          select: { id: true, createdAt: true },
        })
      : null;
    if (query.cursor && !anchor) {
      throw new BadRequestException({
        message: 'Invalid circle cursor',
        errorCode: CircleErrorCode.InvalidCursor,
      });
    }

    const members = await this.prisma.circleMember.findMany({
      where: anchor
        ? {
            ...baseWhere,
            OR: [
              { createdAt: { lt: anchor.createdAt } },
              { createdAt: anchor.createdAt, id: { lt: anchor.id } },
            ],
          }
        : baseWhere,
      include: { circle: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
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
    // All joins are reviewed. The pair lock is shared with the member-invite
    // path so a direct join and an invitation cannot create two applications.
    let invitationId: string;
    try {
      invitationId = await runSerializableTransaction(
        this.prisma,
        async (tx) => {
          await this.memberLock.lock(tx, circleId, [userId]);

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

          await this.admissionPolicy.assertCanApply(tx, circleId, userId);

          if (existing) {
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
      );
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message: 'Already a member or a join request is already pending',
          errorCode: CircleErrorCode.AlreadyMemberOrPending,
        });
      }
      throw error;
    }
    return this.circleInvitationService.getInvitationForViewer(
      userId,
      invitationId,
    );
  }

  async leaveCircle(userId: string, circleId: string): Promise<void> {
    const releasedConversationId = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        await this.memberLock.lock(tx, circleId, [userId]);
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

        await tx.circleInvitation.updateMany({
          where: {
            circleID: circleId,
            applicantID: userId,
            status: 'PENDING',
          },
          data: { status: 'CANCELLED' },
        });

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

        // 退圈走的是 delete,对账的 updatedAt 窗口扫描永远看不见被删的行 ——
        // 座位必须在这里、在同一事务里收掉,否则退圈的人还能读能发能收群消息。
        return this.chatCircleSync.releaseSeatInTx(tx, circleId, userId);
      },
    );
    if (releasedConversationId) {
      await this.chatCircleSync.detachSeat(
        userId,
        releasedConversationId,
        'left',
      );
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
