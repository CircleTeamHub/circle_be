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
import {
  CIRCLE_CREATE_LIMIT,
  GROUP_CAPACITY_HARD_LIMIT,
} from './circle-limits';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { CircleMemberLockService } from './circle-member-lock';
import {
  CircleDetailDto,
  CircleDto,
  MyCircleDto,
  CreateCircleDto,
  UpdateCircleDto,
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

      // 客户端建群不传 maxMembers,所以这一列的默认值直接就是会员配额。配额是
      // 目录数据不是入参,夹一道之后,配额被写大只会退化成"按上限建",而不是一条
      // Postgres 数值溢出的 500(int4 上限 21 亿)。扩容路径用的是同一个常量。
      const capacity = Math.min(
        policy.tier.quotas.groupMembers.actual,
        GROUP_CAPACITY_HARD_LIMIT,
      );
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
          cities: this.normalizeStringList(dto.cities ?? [], 'city'),
          rules: dto.rules ?? '',
          tags: this.normalizeStringList(dto.tags ?? [], 'tag'),
          joinVipRestriction,
          joinCreditRestriction: dto.joinCreditRestriction ?? null,
          joinFancyRestriction: dto.joinFancyRestriction ?? false,
          maxMembers,
          memberCanPost: dto.memberCanPost ?? true,
          // 不传则不写键,默认值只有 schema(宣传期 1)一个来源。
          ...(dto.requiredVerifierCount !== undefined
            ? { requiredVerifierCount: dto.requiredVerifierCount }
            : {}),
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

  /**
   * PATCH /circle/:id —— FE 编辑圈子从 2026-04-22、改群名/群公告从 #145 弃
   * OpenIM 起就在打这个地址,而这条路由此前从不存在,三个入口全 404。
   *
   * 权限对齐 FE 入口(isOwnerOrAdmin / canManageGroup):ACTIVE 的 OWNER 或
   * ADMIN。joinVipRestriction 的天花板锚在**圈主**的会员档而不是操作者 ——
   * 错误码语义就是 EXCEEDS_CREATOR,管理员不能替圈主抬高门槛。
   *
   * data 只收显式传入的字段(undefined 一律跳过):PATCH 语义,漏传不等于清空。
   */
  async updateCircle(
    userId: string,
    circleId: string,
    dto: UpdateCircleDto,
  ): Promise<CircleDetailDto> {
    this.assertAvatarUrlIsSafe(dto.avatarUrl);
    const categories =
      dto.categories !== undefined
        ? this.normalizeStringList(dto.categories, 'category')
        : undefined;
    // cities / tags 原来直写:" Paris " 会入库,而 GET /circle?city=Paris
    // 是精确匹配,从此再也筛不到这个圈子;纯空白项也会被存起来发给客户端。
    const cities =
      dto.cities !== undefined
        ? this.normalizeStringList(dto.cities, 'city')
        : undefined;
    const tags =
      dto.tags !== undefined
        ? this.normalizeStringList(dto.tags, 'tag')
        : undefined;

    await this.prisma.$transaction(async (tx) => {
      const circle = await tx.circle.findFirst({
        where: { id: circleId, deleted: false },
        select: { id: true, ownerID: true },
      });
      if (!circle) {
        throw new NotFoundException({
          message: 'Circle not found',
          errorCode: CircleErrorCode.NotFound,
        });
      }

      // 权限读必须与成员变更串行化：不拿锁的话，一次“退员/降为普通成员”与本事务
      // 可以各自提交，已经被撑下管理权的人仍然改得掉招新策略。圈主一并锁：
      // joinVipRestriction 天花板读的是圈主会员档，一次排序好的获锁比分两步拿安全。
      await this.memberLock.lock(tx, circleId, [userId, circle.ownerID]);
      // 招新策略的写与建单方的读串行化:成员锁两边不相交,不加这把的话
      // 「收严已返回成功」之后仍会有读到旧策略的担保单提交进来。
      await this.memberLock.lockPolicy(tx, circleId);

      const membership = await tx.circleMember.findUnique({
        where: { userID_circleID: { userID: userId, circleID: circleId } },
        select: { role: true, status: true },
      });
      if (
        !membership ||
        membership.status !== 'ACTIVE' ||
        (membership.role !== 'OWNER' && membership.role !== 'ADMIN')
      ) {
        throw new ForbiddenException({
          message: 'Only the circle owner or admin can edit circle settings',
          errorCode: CircleErrorCode.EditForbidden,
        });
      }

      let joinVipRestriction: number | null | undefined;
      if (dto.joinVipRestriction !== undefined) {
        if (dto.joinVipRestriction == null || dto.joinVipRestriction === 0) {
          // 与 create 同规:0/null 都落成「无限制」,不必读圈主会员档。
          joinVipRestriction = null;
        } else {
          // 同 createCircle:锁住圈主再读会员档,门槛决策不能在过期的
          // rollout floor 下提交。
          await this.membershipPolicy.lockUsers(tx, [circle.ownerID]);
          const owner = await tx.user.findUnique({
            where: { id: circle.ownerID },
            select: { vipLevel: true, vipExpiresAt: true },
          });
          if (!owner) {
            throw new NotFoundException({
              message: 'Circle owner not found',
              errorCode: CircleErrorCode.UserNotFound,
            });
          }
          const policy = await this.membershipPolicy.resolveEntitlement(
            owner,
            tx,
            new Date(),
            { lockForWrite: true },
          );
          joinVipRestriction =
            this.admissionPolicy.normalizeCreatorVipRestriction(
              dto.joinVipRestriction,
              policy.level,
            );
        }
      }

      const data = {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(categories !== undefined ? { categories } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
        ...(cities !== undefined ? { cities } : {}),
        ...(dto.rules !== undefined ? { rules: dto.rules } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(dto.joinVipRestriction !== undefined ? { joinVipRestriction } : {}),
        ...(dto.joinCreditRestriction !== undefined
          ? { joinCreditRestriction: dto.joinCreditRestriction }
          : {}),
        ...(dto.joinFancyRestriction !== undefined
          ? { joinFancyRestriction: dto.joinFancyRestriction }
          : {}),
        ...(dto.memberCanPost !== undefined
          ? { memberCanPost: dto.memberCanPost }
          : {}),
        ...(dto.requiredVerifierCount !== undefined
          ? { requiredVerifierCount: dto.requiredVerifierCount }
          : {}),
        ...(dto.memberCanInvite !== undefined
          ? { memberCanInvite: dto.memberCanInvite }
          : {}),
      };
      if (Object.keys(data).length > 0) {
        await tx.circle.update({ where: { id: circleId }, data });
      }
    });

    return this.getCircleDetail(userId, circleId);
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
          // 自助 join 也要快照 requiredVerifierCount,与 invite / PATCH 同一把
          // 策略锁下串行。
          await this.memberLock.lockPolicy(tx, circleId);

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
            // 票数是建单那一刻圈子策略的快照:后续调 requiredVerifierCount
            // 不影响在途申请(进度条/成结判定读的都是 invitation.requiredCount)。
            const policy = await tx.circle.findFirst({
              where: { id: circleId, deleted: false },
              select: { requiredVerifierCount: true },
            });
            if (!policy) {
              throw new NotFoundException({
                message: 'Circle not found',
                errorCode: CircleErrorCode.NotFound,
              });
            }
            const created = await tx.circleInvitation.create({
              data: {
                circleID: circleId,
                applicantID: userId,
                inviterID: userId,
                requiredCount: policy.requiredVerifierCount,
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
      requiredVerifierCount: circle.requiredVerifierCount,
      memberCanInvite: circle.memberCanInvite,
      groupID: circle.groupID,
      memberCount: circle.memberCount,
      postCount: circle.postCount,
      createdAt: circle.createdAt.toISOString(),
    };
  }
}
