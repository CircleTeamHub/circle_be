import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CirclePost,
  Prisma,
  ReportReviewStatus,
  User,
} from 'src/generated/prisma';
import { CircleErrorCode, PlazaErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { OpenimService } from 'src/openim/openim.service';
import { NotificationService } from 'src/notification/notification.service';
import { DisplayIconDto } from 'src/icon/dto/icon.dto';
import { IconService } from 'src/icon/icon.service';
import { likedOnToday } from 'src/like/like.util';
import {
  decodeFeedCursor,
  encodeFeedCursor,
  feedCursorWhere,
} from 'src/utils/feed-cursor';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  CreatePlazaPostDto,
  MyCirclePostDto,
  PlazaFeedQueryDto,
  PlazaPostDto,
  PostSignupItemDto,
} from './dto/circle-plaza.dto';

// A plaza post joined with the relations every DTO mapping needs.
// `circleLinks` carries the full set of circles the post is shared to (M2M);
// `circle` remains the primary circle for backward compatibility.
type PlazaPostWithRelations = Prisma.CirclePostGetPayload<{
  include: {
    author: true;
    circle: true;
    circleLinks: { include: { circle: true } };
  };
}>;

// The viewer fields that gate post interaction / signup eligibility.
type ViewerEntitlements = Pick<
  User,
  'vipLevel' | 'creditScore' | 'fancyNumber'
>;

// The post restriction fields each eligibility check reads. Picking them keeps
// both the full-post and the narrowly-`select`ed callers type-safe — a typo'd
// field name fails to compile instead of silently disabling a gate.
type InteractRestrictionFields = Pick<
  CirclePost,
  'vipRestriction' | 'creditRestriction' | 'fancyRestriction'
>;
type SignupRestrictionFields = Pick<
  CirclePost,
  'signupVipRestriction' | 'signupCreditRestriction' | 'signupFancyRestriction'
>;

const MAX_COLLABORATION_RECOGNITIONS_PER_POST = 3;
const CIRCLE_POST_AUTO_END_MS = 24 * 60 * 60 * 1000;
const CIRCLE_POST_AUTO_END_BATCH_SIZE = 100;
const DEFAULT_CIRCLE_POST_EXPIRY_HOURS = 24;
// 发帖扇出通知的收件人上限：正常测试期圈子远小于此，作为超大圈的安全阀，
// 命中时记日志而非静默截断。
const CIRCLE_POST_PUBLISH_FANOUT_CAP = 500;

@Injectable()
export class CirclePlazaService {
  private readonly logger = new Logger(CirclePlazaService.name);
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly notificationService: NotificationService,
    private readonly iconService: IconService,
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
  }

  // 逗号分隔的过滤列表最多接受这么多项，防止恶意超长入参生成超大 IN 子句。
  private static readonly MAX_FILTER_ITEMS = 50;

  private parseCommaList(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, CirclePlazaService.MAX_FILTER_ITEMS);
  }

  // 建帖城市多选归一化：优先用 cities，回落到旧的单个 city；去空白 + 去重 + 限量。
  private normalizePostCities(
    cities: string[] | undefined,
    legacyCity: string | undefined,
  ): string[] {
    const source = cities?.length ? cities : legacyCity ? [legacyCity] : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of source) {
      const value = raw?.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= CirclePlazaService.MAX_FILTER_ITEMS) break;
    }
    return out;
  }

  // 圈子成员可见范围：圈子未删除 且 viewer 是该圈 ACTIVE 成员。
  // getFeed 与 getPost 共用，保证「列表能看到」与「详情能打开」的可见性一致。
  private memberCircleScope(viewerId: string): Prisma.CircleWhereInput {
    return {
      deleted: false,
      members: { some: { userID: viewerId, status: 'ACTIVE' } },
    };
  }

  // 建帖圈子多选归一化：优先用 circleIds，回落到旧的单个 circleId；去空白 + 去重 + 限量。
  // 保持顺序（circleIds[0] = 主圈子）。
  private normalizeCircleIds(
    circleIds: string[] | undefined,
    legacyCircleId: string | undefined,
  ): string[] {
    const source = circleIds?.length
      ? circleIds
      : legacyCircleId
        ? [legacyCircleId]
        : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of source) {
      const value = raw?.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= CirclePlazaService.MAX_FILTER_ITEMS) break;
    }
    return out;
  }

  /**
   * Rejects post images not served from this application's own storage.
   * A plaza post is shown to every feed viewer, so off-origin image URLs are
   * a cross-user tracking / phishing vector. Skipped when MinIO is unconfigured.
   */
  private assertImagesAreSafe(images: string[] | undefined): void {
    if (!this.minioPublicUrl || !images?.length) return;
    const prefix = this.minioPublicUrl.replace(/\/$/, '');
    for (const image of images) {
      if (image !== prefix && !image.startsWith(`${prefix}/`)) {
        throw new BadRequestException(
          "post images must be served from this application's storage",
        );
      }
    }
  }

  async createPost(
    userId: string,
    dto: CreatePlazaPostDto,
  ): Promise<PlazaPostDto> {
    // 圈子多选：优先 dto.circleIds（去重），回落到旧的单个 dto.circleId。
    // 主圈子 = circleIds[0]。至少要有一个圈子。
    const circleIds = this.normalizeCircleIds(dto.circleIds, dto.circleId);
    if (circleIds.length === 0) {
      throw new BadRequestException({
        message: 'At least one circle is required',
        errorCode: PlazaErrorCode.NotActiveMember,
      });
    }
    const primaryCircleId = circleIds[0];

    // 校验每一个目标圈子：用户都必须是 ACTIVE 成员、圈子未删除、且有发帖权限。
    const memberships = await this.prisma.circleMember.findMany({
      where: { userID: userId, circleID: { in: circleIds } },
      include: { circle: true },
    });
    const membershipByCircle = new Map(memberships.map((m) => [m.circleID, m]));
    for (const circleId of circleIds) {
      const membership = membershipByCircle.get(circleId);
      if (!membership || membership.status !== 'ACTIVE') {
        throw new ForbiddenException({
          message: 'You must be an active member of the circle to post',
          errorCode: PlazaErrorCode.NotActiveMember,
        });
      }
      if (membership.circle.deleted) {
        throw new NotFoundException({
          message: 'Circle not found',
          errorCode: CircleErrorCode.NotFound,
        });
      }
      // Members may be blocked from posting (owners/admins always can).
      if (!membership.circle.memberCanPost && membership.role === 'MEMBER') {
        throw new ForbiddenException({
          message: '该圈子仅管理员可以发帖',
          errorCode: PlazaErrorCode.AdminOnlyPost,
        });
      }
    }

    this.assertImagesAreSafe(dto.images);

    if (dto.noteId) {
      const note = await this.prisma.note.findFirst({
        where: {
          id: dto.noteId,
          ownerID: userId,
          available: true,
          status: { not: 'DELETED' },
        },
        select: { id: true },
      });
      if (!note) {
        throw new BadRequestException({
          message:
            'Note not found, unavailable, or not owned by the current user',
          errorCode: PlazaErrorCode.NoteInvalid,
        });
      }
    }

    const expiresInHours =
      dto.expiresInHours ?? DEFAULT_CIRCLE_POST_EXPIRY_HOURS;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    // 城市多选：优先用 dto.cities（去空白/去重），回落到旧的单个 dto.city。
    // 主城市 city = cities[0]，兼容旧字段/旧客户端。
    const cities = this.normalizePostCities(dto.cities, dto.city);
    const primaryCity = cities[0] ?? null;
    const publishRecipientIds = await this.getCirclePostPublishRecipientIds(
      userId,
      circleIds,
    );

    const { post, publishedNotifications } = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.circlePost.create({
          data: {
            content: dto.content,
            images: dto.images ?? [],
            tags: dto.tags ?? [],
            city: primaryCity,
            cities,
            isHorn: dto.isHorn ?? false,
            noteID: dto.noteId ?? null,
            vipRestriction: dto.vipRestriction ?? null,
            creditRestriction: dto.creditRestriction ?? null,
            fancyRestriction: dto.fancyRestriction ?? false,
            signupVipRestriction: dto.signupVipRestriction ?? null,
            signupCreditRestriction: dto.signupCreditRestriction ?? null,
            signupFancyRestriction: dto.signupFancyRestriction ?? false,
            authorID: userId,
            expiresAt,
            circleID: primaryCircleId,
            // 关联表：主圈子 + 其余圈子都建一条 link。
            circleLinks: {
              create: circleIds.map((circleId) => ({
                circle: { connect: { id: circleId } },
              })),
            },
          },
          include: {
            author: true,
            circle: true,
            circleLinks: { include: { circle: true } },
          },
        });

        // 每个圈子的 postCount 都 +1。
        await tx.circle.updateMany({
          where: { id: { in: circleIds } },
          data: { postCount: { increment: 1 } },
        });

        const notifications =
          await this.notificationService.createCirclePostPublishedNotifications(
            tx,
            {
              postId: created.id,
              fromUserId: userId,
              recipientIds: publishRecipientIds,
            },
          );

        return { post: created, publishedNotifications: notifications };
      },
    );

    for (const { toUserId, notification } of publishedNotifications) {
      try {
        this.realtime.broadcastNotificationCreated(toUserId, notification);
      } catch (error) {
        this.logger.error(
          `circle post publish realtime broadcast failed (post=${post.id}, user=${toUserId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const displayIconsByAuthor = await this.getDisplayIconsByAuthorIds([
      post.author.id,
    ]);

    return this.toPlazaPostDto(
      post,
      true,
      false,
      true,
      displayIconsByAuthor.get(post.author.id) ?? [],
    );
  }

  /**
   * Resolve a deterministic, capped set of ACTIVE recipients before the post
   * transaction. Bidirectional blocks are excluded by the database query.
   */
  private async getCirclePostPublishRecipientIds(
    authorId: string,
    circleIds: string[],
  ): Promise<string[]> {
    const members = await this.prisma.circleMember.findMany({
      where: {
        circleID: { in: circleIds },
        status: 'ACTIVE',
        userID: { not: authorId },
        user: {
          blocksIssued: { none: { blockedID: authorId } },
          blocksReceived: { none: { blockerID: authorId } },
        },
      },
      select: { userID: true },
      distinct: ['userID'],
      orderBy: { userID: 'asc' },
      take: CIRCLE_POST_PUBLISH_FANOUT_CAP + 1,
    });

    if (members.length > CIRCLE_POST_PUBLISH_FANOUT_CAP) {
      this.logger.warn(
        `circle post publish fan-out capped at ${CIRCLE_POST_PUBLISH_FANOUT_CAP} recipients (author=${authorId}, eligible>${CIRCLE_POST_PUBLISH_FANOUT_CAP})`,
      );
    }
    return members
      .slice(0, CIRCLE_POST_PUBLISH_FANOUT_CAP)
      .map(({ userID }) => userID);
  }

  async getFeed(
    viewerId: string,
    query: PlazaFeedQueryDto,
  ): Promise<{
    items: PlazaPostDto[];
    total: number | null;
    page: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    // Keyset (cursor) pagination mirrors the trace feed: O(limit) per page at
    // any depth and no per-page count(). Offset (page) kept for clients not yet
    // migrated; both paths return `nextCursor` so clients can switch mid-scroll.
    const cursor = query.cursor
      ? decodeFeedCursor(query.cursor, PlazaErrorCode.InvalidCursor)
      : null;
    const useKeyset = cursor !== null;
    const skip = useKeyset ? 0 : (page - 1) * limit;

    const circleIds = this.parseCommaList(query.circleIds);
    const cities = this.parseCommaList(query.cities);

    // 可见性 + 圈子筛选合并进同一个 link 条件：一条动态只有当它 link 到
    // 「viewer 是成员的那个圈子」时，才在该圈 feed 出现——杜绝跨圈泄露
    //（帖子同时 link 到 A、B，viewer 仅是 A 成员时，按 B 筛选不会命中）。
    const linkFilter: Prisma.CirclePostCircleWhereInput = {
      circle: this.memberCircleScope(viewerId),
    };
    if (query.circleId) {
      linkFilter.circleID = query.circleId;
    } else if (circleIds.length > 0) {
      linkFilter.circleID = { in: circleIds };
    }

    const whereBase: Prisma.CirclePostWhereInput = {
      ...this.activeUnexpiredPostWhere(),
      circleLinks: { some: linkFilter },
    };
    // 城市筛选走 cities[] 数组谓词（旧数据已回填 cities，故仍能命中）：
    // 单城市 = 数组包含该城市；多城市 = 数组与筛选集有交集。
    if (query.city) {
      whereBase.cities = { has: query.city };
    } else if (cities.length > 0) {
      whereBase.cities = { hasSome: cities };
    }
    const where: Prisma.CirclePostWhereInput = cursor
      ? { AND: [whereBase, feedCursorWhere(cursor)] }
      : whereBase;

    // Keyset fetches one extra row to decide `hasMore` without a count();
    // offset still returns an accurate `total` for the legacy page-number UI.
    const [rows, total, viewer] = await Promise.all([
      this.prisma.circlePost.findMany({
        where,
        include: {
          author: true,
          circle: true,
          circleLinks: { include: { circle: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(useKeyset ? { take: limit + 1 } : { skip, take: limit }),
      }),
      useKeyset
        ? Promise.resolve<number | null>(null)
        : this.prisma.circlePost.count({ where }),
      this.prisma.user.findUnique({
        where: { id: viewerId },
        select: { vipLevel: true, creditScore: true, fancyNumber: true },
      }),
    ]);

    const hasMore = useKeyset
      ? rows.length > limit
      : skip + rows.length < (total ?? 0);
    const posts = useKeyset ? rows.slice(0, limit) : rows;
    const lastPost = posts[posts.length - 1];
    const nextCursor =
      hasMore && lastPost
        ? encodeFeedCursor(lastPost.createdAt, lastPost.id)
        : null;

    const postIds = posts.map((p) => p.id);
    const [mySignups, displayIconsByAuthor] = await Promise.all([
      postIds.length
        ? this.prisma.circlePostSignup.findMany({
            where: { userID: viewerId, postID: { in: postIds } },
            select: { postID: true },
          })
        : Promise.resolve([]),
      this.getDisplayIconsByAuthorIds(posts.map((post) => post.author.id)),
    ]);
    const signedSet = new Set(mySignups.map((s) => s.postID));

    const items = posts.map((post) =>
      this.toPlazaPostDto(
        post,
        this.checkCanInteract(post, viewer),
        signedSet.has(post.id),
        this.checkCanSignup(post, viewer),
        displayIconsByAuthor.get(post.author.id) ?? [],
      ),
    );

    this.logger.debug(
      `plaza feed: viewer=${viewerId} ` +
        `circleFilter=${query.circleId ?? circleIds.length} ` +
        `cityFilter=${query.city ?? cities.length} ` +
        `mode=${useKeyset ? 'keyset' : 'offset'} page=${page} ` +
        `returned=${posts.length} total=${total ?? '-'}`,
    );

    return { items, total, page, limit, hasMore, nextCursor };
  }

  async getPost(viewerId: string, postId: string): Promise<PlazaPostDto> {
    const [post, viewer] = await Promise.all([
      this.prisma.circlePost.findFirst({
        where: {
          ...this.activeUnexpiredPostWhere(),
          id: postId,
          // 与 feed 同一套可见性：viewer 必须是该动态所属任一圈子的 ACTIVE 成员，
          // 否则 findFirst 不命中 → 抛 404，避免凭 id 直读到非本圈私密动态。
          circleLinks: { some: { circle: this.memberCircleScope(viewerId) } },
        },
        include: {
          author: true,
          circle: true,
          circleLinks: { include: { circle: true } },
        },
      }),
      this.prisma.user.findUnique({
        where: { id: viewerId },
        select: { vipLevel: true, creditScore: true, fancyNumber: true },
      }),
    ]);

    if (!post) {
      // 区分「非本圈成员」与「帖子真的不存在/已删/已过期」：去掉成员可见性再查一次。
      // 若帖子仍存在(仅因 viewer 非成员而被过滤)，回传主圈子信息，让前端提示「申请加入」。
      const visible = await this.prisma.circlePost.findFirst({
        where: {
          ...this.activeUnexpiredPostWhere(),
          id: postId,
          circleLinks: { some: { circle: { deleted: false } } },
        },
        select: {
          circle: { select: { id: true, name: true, deleted: true } },
          circleLinks: {
            where: { circle: { deleted: false } },
            select: { circle: { select: { id: true, name: true } } },
            take: 1,
          },
        },
      });
      let joinCircle: { id: string; name: string } | null = null;
      if (visible) {
        joinCircle = visible.circle.deleted
          ? (visible.circleLinks[0]?.circle ?? null)
          : visible.circle;
      }
      if (joinCircle) {
        throw new ForbiddenException({
          message: 'You are not a member of this circle',
          errorCode: PlazaErrorCode.NotCircleMember,
          details: {
            circleId: joinCircle.id,
            circleName: joinCircle.name,
          },
        });
      }
      throw new NotFoundException({
        message: 'Post not found',
        errorCode: PlazaErrorCode.PostNotFound,
      });
    }

    const [signed, displayIconsByAuthor] = await Promise.all([
      this.prisma.circlePostSignup.findUnique({
        where: { postID_userID: { postID: postId, userID: viewerId } },
        select: { id: true },
      }),
      this.getDisplayIconsByAuthorIds([post.author.id]),
    ]);

    return this.toPlazaPostDto(
      post,
      this.checkCanInteract(post, viewer),
      Boolean(signed),
      this.checkCanSignup(post, viewer),
      displayIconsByAuthor.get(post.author.id) ?? [],
    );
  }

  async deletePost(userId: string, postId: string): Promise<void> {
    const post = await this.prisma.circlePost.findFirst({
      where: { ...this.activeUnexpiredPostWhere(), id: postId },
    });
    if (!post) {
      throw new NotFoundException({
        message: 'Post not found',
        errorCode: PlazaErrorCode.PostNotFound,
      });
    }
    if (post.authorID !== userId) {
      throw new ForbiddenException({
        message: 'Only the author can delete this post',
        errorCode: PlazaErrorCode.DeleteAuthorOnly,
      });
    }

    // 该动态关联的所有圈子（含主圈子）都要 postCount -1。
    const links = await this.prisma.circlePostCircle.findMany({
      where: { postID: postId },
      select: { circleID: true },
    });
    const linkedCircleIds = links.length
      ? [...new Set(links.map((l) => l.circleID))]
      : [post.circleID];

    await this.prisma.$transaction(async (tx) => {
      // 原子认领：只把 ACTIVE→DELETED 的那一次算作真删除，才递减 postCount。
      // 并发/重试的第二次 count=0 → 跳过递减，避免每个圈子被多扣（甚至扣成负数）。
      const claimed = await tx.circlePost.updateMany({
        where: { id: postId, status: 'ACTIVE' },
        data: { status: 'DELETED' },
      });
      if (claimed.count !== 1) return;

      await tx.circle.updateMany({
        where: { id: { in: linkedCircleIds } },
        data: { postCount: { decrement: 1 } },
      });
    });
  }

  /** 举报一条圈子帖子。同一用户对同一帖只记一条，重复举报幂等更新原因。 */
  async reportPost(
    userId: string,
    postId: string,
    reason?: string,
  ): Promise<{ reported: boolean }> {
    const post = await this.prisma.circlePost.findFirst({
      where: {
        ...this.activeUnexpiredPostWhere(),
        id: postId,
        circleLinks: {
          some: { circle: this.memberCircleScope(userId) },
        },
      },
      select: { id: true, authorID: true },
    });
    if (!post) {
      throw new NotFoundException({
        message: 'Post not found',
        errorCode: PlazaErrorCode.PostNotFound,
      });
    }
    if (post.authorID === userId) {
      throw new ForbiddenException({
        message: 'Cannot report your own post',
        errorCode: PlazaErrorCode.ReportSelf,
      });
    }

    const trimmed = reason?.trim();
    // review 修复：幂等只对 PENDING 行生效（补充理由）；审结行是管理员已经
    // 看过的证据，绝不改写 —— 审结后的新举报建全新 PENDING 行重新进队列。
    // 并发双报由 PENDING 局部唯一索引兜住，P2002 输家改走更新路径。
    const pending = await this.prisma.circlePostReport.findFirst({
      where: {
        postID: postId,
        reporterID: userId,
        status: ReportReviewStatus.PENDING,
      },
      select: { id: true },
    });
    if (pending) {
      await this.prisma.circlePostReport.update({
        where: { id: pending.id },
        data: { reason: trimmed || null },
      });
      return { reported: true };
    }
    try {
      await this.prisma.circlePostReport.create({
        data: { postID: postId, reporterID: userId, reason: trimmed || null },
      });
    } catch (error) {
      if (this.prismaErrorCode(error) !== 'P2002') throw error;
      const raced = await this.prisma.circlePostReport.findFirst({
        where: {
          postID: postId,
          reporterID: userId,
          status: ReportReviewStatus.PENDING,
        },
        select: { id: true },
      });
      if (raced) {
        await this.prisma.circlePostReport.update({
          where: { id: raced.id },
          data: { reason: trimmed || null },
        });
      }
    }
    return { reported: true };
  }

  async signupForPost(
    userId: string,
    postId: string,
  ): Promise<{ signed: boolean; signupCount: number }> {
    // 报名资格门槛（signup*Restriction）独立于帖子查看/互动门槛
    // （vipRestriction 等）；后者由 checkCanInteract 管，此处只看 signup* 字段。
    const post = await this.prisma.circlePost.findFirst({
      where: {
        ...this.activeUnexpiredPostWhere(),
        id: postId,
        circleLinks: { some: { circle: { deleted: false } } },
      },
      select: {
        id: true,
        authorID: true,
        circleID: true,
        signupVipRestriction: true,
        signupCreditRestriction: true,
        signupFancyRestriction: true,
        circleLinks: {
          where: { circle: this.memberCircleScope(userId) },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!post) {
      throw new NotFoundException({
        message: 'Post not found',
        errorCode: PlazaErrorCode.PostNotFound,
      });
    }

    // The author manages signups for their own post and never signs up for it.
    if (post.authorID === userId) {
      throw new ForbiddenException({
        message: '不能给自己发布的帖子报名',
        errorCode: PlazaErrorCode.SignupSelf,
      });
    }

    // Fast-path pre-check; the unique constraint inside the transaction is the
    // real guard against concurrent double-taps (see catch block below).
    const existing = await this.prisma.circlePostSignup.findUnique({
      where: { postID_userID: { postID: postId, userID: userId } },
      select: { id: true },
    });
    if (existing) {
      const current = await this.prisma.circlePost.findUnique({
        where: { id: postId },
        select: { signupCount: true },
      });
      return { signed: true, signupCount: current?.signupCount ?? 0 };
    }

    if (post.circleLinks.length === 0) {
      throw new NotFoundException({
        message: 'Post not found',
        errorCode: PlazaErrorCode.PostNotFound,
      });
    }

    // 报名资格校验（独立于帖子查看限制 vipRestriction，仅看 signup* 门槛）
    const viewer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipLevel: true, creditScore: true, fancyNumber: true },
    });
    if (!this.checkCanSignup(post, viewer)) {
      throw new ForbiddenException({
        message: '您的等级不满足该帖子的报名要求',
        errorCode: PlazaErrorCode.SignupIneligible,
      });
    }

    let updated: { signupCount: number };
    try {
      updated = await runSerializableTransaction(this.prisma, async (tx) => {
        const stillAuthorized = await tx.circlePost.findFirst({
          where: {
            ...this.activeUnexpiredPostWhere(),
            id: postId,
            circleLinks: {
              some: { circle: this.memberCircleScope(userId) },
            },
          },
          select: { id: true },
        });
        if (!stillAuthorized) {
          throw new NotFoundException({
            message: 'Post not found',
            errorCode: PlazaErrorCode.PostNotFound,
          });
        }

        await tx.circlePostSignup.create({
          data: { postID: postId, userID: userId },
        });
        // signupCount 是去规范化的软缓存；getPostSignups / COUNT(*) 才是真实来源。
        const p = await tx.circlePost.update({
          where: { id: postId },
          data: { signupCount: { increment: 1 } },
          select: { signupCount: true },
        });
        return p;
      });
    } catch (error) {
      // Two concurrent requests can both pass the pre-check; the loser hits the
      // unique constraint (P2002). Treat it as "already signed up" and stay
      // idempotent instead of surfacing a 409.
      if (this.isPrismaUniqueConstraintError(error)) {
        const current = await this.prisma.circlePost.findUnique({
          where: { id: postId },
          select: { signupCount: true },
        });
        return { signed: true, signupCount: current?.signupCount ?? 0 };
      }
      throw error;
    }

    // Best-effort: the signup is persisted and idempotent on retry, so a
    // realtime failure must not turn this into a 500. Only the post author has a
    // signup-management badge to refresh (self-signup is rejected above).
    try {
      await this.realtime.broadcastSignupUnread(post.authorID);
      const notification =
        await this.notificationService.createCirclePostSignupNotification({
          toUserId: post.authorID,
          fromUserId: userId,
          postId,
        });
      if (notification) {
        await this.realtime.broadcastInteractionUnread(post.authorID);
        this.realtime.broadcastNotificationCreated(post.authorID, notification);
      }
    } catch {
      // swallow: write is authoritative
    }
    return { signed: true, signupCount: updated.signupCount };
  }

  private prismaErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  }

  private isPrismaUniqueConstraintError(error: unknown): boolean {
    return this.prismaErrorCode(error) === 'P2002';
  }

  async cancelSignup(
    userId: string,
    postId: string,
  ): Promise<{ signed: boolean; signupCount: number }> {
    const result = await this.prisma.$transaction(async (tx) => {
      // 原子认领：并发取消只有一次 deleteMany 命中，才递减 signupCount。
      // 落败方 count=0 → 不递减、不广播，与 signupForPost 的 P2002 分支对称，
      // 读后删则会让第二次 delete 抛 P2025(500) 并把计数多扣一次。
      const claimed = await tx.circlePostSignup.deleteMany({
        where: { postID: postId, userID: userId },
      });
      if (claimed.count !== 1) {
        const current = await tx.circlePost.findUnique({
          where: { id: postId },
          select: { signupCount: true },
        });
        return { cancelled: false, signupCount: current?.signupCount ?? 0 };
      }

      const post = await tx.circlePost.update({
        where: { id: postId },
        data: { signupCount: { decrement: 1 } },
        select: { signupCount: true, authorID: true },
      });
      return {
        cancelled: true,
        signupCount: post.signupCount,
        authorID: post.authorID,
      };
    });

    // Cancelling can drop an unseen signup, so refresh the author's badge.
    if (result.cancelled) {
      try {
        await this.realtime.broadcastSignupUnread(result.authorID);
      } catch {
        // swallow: write is authoritative
      }
    }

    return { signed: false, signupCount: Math.max(0, result.signupCount) };
  }

  async getPostSignups(
    authorId: string,
    postId: string,
  ): Promise<{
    items: {
      id: string;
      nickname: string;
      avatarUrl: string | null;
      accountId: string;
      signedAt: string;
    }[];
  }> {
    await this.requireOwnPost(authorId, postId);
    const signups = await this.prisma.circlePostSignup.findMany({
      where: { postID: postId },
      include: {
        user: {
          select: {
            id: true,
            nickname: true,
            avatarUrl: true,
            accountId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      items: signups.map((s) => ({
        id: s.user.id,
        nickname: s.user.nickname,
        avatarUrl: s.user.avatarUrl,
        accountId: s.user.accountId,
        signedAt: s.createdAt.toISOString(),
      })),
    };
  }

  // ─── Signup management (报名管理) ───────────────────────────────────────────

  /** Posts authored by the user, newest first, with per-post unread signup counts. */
  async listMyPosts(
    authorId: string,
    page = 1,
  ): Promise<{
    items: MyCirclePostDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const limit = 20;
    const skip = (Math.max(1, page) - 1) * limit;
    const where: Prisma.CirclePostWhereInput = {
      authorID: authorId,
      OR: [
        { status: 'ACTIVE' },
        { status: 'ENDED', collaborationRecognizedAt: null },
      ],
    };
    const [posts, total] = await Promise.all([
      this.prisma.circlePost.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          circleID: true,
          content: true,
          images: true,
          signupCount: true,
          status: true,
          createdAt: true,
          expiresAt: true,
        },
      }),
      this.prisma.circlePost.count({ where }),
    ]);

    const ids = posts.map((p) => p.id);
    const unreadGroups = ids.length
      ? await this.prisma.circlePostSignup.groupBy({
          by: ['postID'],
          where: { postID: { in: ids }, seenByAuthor: false },
          _count: { _all: true },
        })
      : [];
    const unreadByPost = new Map(
      unreadGroups.map((g) => [g.postID, g._count._all]),
    );

    return {
      items: posts.map((p) => ({
        id: p.id,
        circleId: p.circleID,
        excerpt: p.content.slice(0, 60),
        firstImage: p.images[0] ?? null,
        signupCount: p.signupCount,
        unreadSignupCount: unreadByPost.get(p.id) ?? 0,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        expiresAt: this.formatPostExpiresAt(p),
      })),
      total,
      page: Math.max(1, page),
      limit,
      hasMore: skip + posts.length < total,
    };
  }

  async sweepExpiredPosts(now = new Date()): Promise<{ count: number }> {
    const cutoff = new Date(now.getTime() - CIRCLE_POST_AUTO_END_MS);
    const expiredWhere: Prisma.CirclePostWhereInput = {
      status: 'ACTIVE',
      OR: [
        { expiresAt: { lte: now } },
        { expiresAt: null, createdAt: { lte: cutoff } },
      ],
    };

    // Serialize the sweep with a transaction-scoped advisory lock so concurrent
    // ticks / multiple instances never process the same batch (which would
    // double-notify). The lock is released when the transaction commits.
    const endedPosts = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('circle-post-expiry-sweep'))`;

      const batch = await tx.circlePost.findMany({
        where: expiredWhere,
        select: { id: true, authorID: true },
        orderBy: [
          { expiresAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
        ],
        take: CIRCLE_POST_AUTO_END_BATCH_SIZE,
      });
      if (batch.length === 0) {
        return [];
      }

      // Bulk-end the whole batch in one write. The lock guarantees no other
      // sweep touched these rows, so the count equals batch.length.
      await tx.circlePost.updateMany({
        where: { id: { in: batch.map((post) => post.id) }, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now },
      });

      return batch;
    });

    if (endedPosts.length === 0) {
      return { count: 0 };
    }

    for (const post of endedPosts) {
      try {
        const notification =
          await this.notificationService.createCirclePostAutoEndedNotification({
            toUserId: post.authorID,
            postId: post.id,
          });
        if (notification) {
          await this.realtime.broadcastInteractionUnread(post.authorID);
          this.realtime.broadcastNotificationCreated(
            post.authorID,
            notification,
          );
        }
      } catch (error) {
        this.logger.error(
          `circle post auto-end notification failed (post=${post.id}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(`auto-ended ${endedPosts.length} expired circle posts`);

    return { count: endedPosts.length };
  }

  /** Signers of one of the author's own posts, with recognition state. */
  async getMyPostSignups(
    authorId: string,
    postId: string,
  ): Promise<{ items: PostSignupItemDto[]; recognitionOpen: boolean }> {
    const post = await this.prisma.circlePost.findFirst({
      where: { id: postId, authorID: authorId },
      select: {
        id: true,
        status: true,
        collaborationRecognizedAt: true,
      },
    });
    if (!post) {
      throw new NotFoundException({
        message: 'Post not found',
        errorCode: PlazaErrorCode.PostNotFound,
      });
    }
    const signups = await this.prisma.circlePostSignup.findMany({
      where: { postID: postId },
      include: {
        user: {
          select: {
            id: true,
            nickname: true,
            avatarUrl: true,
            accountId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const signerIds = signups.map((signup) => signup.user.id);
    const recognizedRows =
      signerIds.length > 0
        ? await this.prisma.collaborationRecognition.findMany({
            where: {
              circlePostID: postId,
              recipientID: { in: signerIds },
              revokedAt: null,
            },
            select: { recipientID: true },
          })
        : [];
    const recognizedUserIds = new Set(
      recognizedRows.map((row) => row.recipientID),
    );
    const displayIconsByUser = await this.getDisplayIconsByAuthorIds(signerIds);
    return {
      recognitionOpen:
        post.status === 'ENDED' && post.collaborationRecognizedAt === null,
      items: signups.map((s) => ({
        userId: s.user.id,
        imUserId: OpenimService.toImUserId(s.user.id),
        nickname: s.user.nickname,
        avatarUrl: s.user.avatarUrl,
        accountId: s.user.accountId,
        signedAt: s.createdAt.toISOString(),
        seen: s.seenByAuthor,
        displayIcons: displayIconsByUser.get(s.user.id) ?? [],
        recognized: recognizedUserIds.has(s.user.id),
      })),
    };
  }

  /** Mark every unseen signup on the author's post as read; refresh the badge. */
  async markPostSignupsSeen(
    authorId: string,
    postId: string,
  ): Promise<{ count: number }> {
    await this.requireOwnPost(authorId, postId);
    const result = await this.prisma.circlePostSignup.updateMany({
      where: { postID: postId, seenByAuthor: false },
      data: { seenByAuthor: true, seenAt: new Date() },
    });
    if (result.count > 0) {
      try {
        await this.realtime.broadcastSignupUnread(authorId);
      } catch {
        // swallow: write is authoritative
      }
    }
    return { count: result.count };
  }

  async recognizePostCollaborators(
    authorId: string,
    postId: string,
    recipientIds: string[],
  ): Promise<{ count: number; recognizedUserIds: string[] }> {
    const uniqueRecipientIds = Array.from(
      new Set(recipientIds.map((id) => id.trim()).filter(Boolean)),
    );

    if (uniqueRecipientIds.length === 0) {
      throw new BadRequestException({
        message: 'Select at least one collaborator',
        errorCode: PlazaErrorCode.RecognizeMinOne,
      });
    }
    if (uniqueRecipientIds.length > MAX_COLLABORATION_RECOGNITIONS_PER_POST) {
      throw new BadRequestException({
        message: 'Select at most three collaborators',
        errorCode: PlazaErrorCode.RecognizeMaxThree,
      });
    }
    if (uniqueRecipientIds.includes(authorId)) {
      throw new ForbiddenException({
        message: 'Cannot recognize yourself',
        errorCode: PlazaErrorCode.RecognizeSelf,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('like-counter-reconciliation', 0))`;
      const post = await tx.circlePost.findFirst({
        where: {
          id: postId,
          authorID: authorId,
          status: { in: ['ACTIVE', 'ENDED'] },
        },
        select: {
          id: true,
          authorID: true,
          circleID: true,
          circleLinks: { select: { circleID: true } },
        },
      });
      if (!post) {
        throw new NotFoundException({
          message: 'Post not found',
          errorCode: PlazaErrorCode.PostNotFound,
        });
      }
      // 认定资格：报名者仍是该动态「所属任一圈子」的 ACTIVE 成员即可（M2M）。
      const postCircleIds = post.circleLinks?.length
        ? [...new Set(post.circleLinks.map((l) => l.circleID))]
        : [post.circleID];

      // A recipient is eligible only if they signed up for the post AND are
      // still an ACTIVE member of the post's circle. Someone who signed up and
      // later left (or was removed from) the circle must not earn recognition.
      const signedUsers = await tx.circlePostSignup.findMany({
        where: {
          postID: postId,
          userID: { in: uniqueRecipientIds },
        },
        select: { userID: true },
      });
      const signedUserIds = new Set(signedUsers.map((signup) => signup.userID));
      const allRecipientsSignedUp = uniqueRecipientIds.every((recipientId) =>
        signedUserIds.has(recipientId),
      );
      if (!allRecipientsSignedUp) {
        throw new BadRequestException({
          message: 'Only users who signed up for the post can be recognized',
          errorCode: PlazaErrorCode.RecognizeNotSigned,
        });
      }

      const activeMembers = await tx.circleMember.findMany({
        where: {
          circleID: { in: postCircleIds },
          status: 'ACTIVE',
          userID: { in: uniqueRecipientIds },
        },
        select: { userID: true },
      });
      const activeMemberIds = new Set(
        activeMembers.map((member) => member.userID),
      );
      const allRecipientsActiveMembers = uniqueRecipientIds.every(
        (recipientId) => activeMemberIds.has(recipientId),
      );
      if (!allRecipientsActiveMembers) {
        throw new BadRequestException({
          message: 'Only active members of the circle can be recognized',
          errorCode: PlazaErrorCode.RecognizeNotMember,
        });
      }

      // Never recognize someone in a block relationship with the author
      // (either direction).
      const block = await tx.block.findFirst({
        where: {
          OR: [
            { blockerID: authorId, blockedID: { in: uniqueRecipientIds } },
            { blockerID: { in: uniqueRecipientIds }, blockedID: authorId },
          ],
        },
        select: { id: true },
      });
      if (block) {
        throw new ForbiddenException({
          message: 'Cannot recognize a blocked user',
          errorCode: PlazaErrorCode.RecognizeBlocked,
        });
      }

      const claimed = await tx.circlePost.updateMany({
        where: {
          id: postId,
          authorID: authorId,
          collaborationRecognizedAt: null,
        },
        data: { collaborationRecognizedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException({
          message: 'Collaboration recognition has already been submitted',
          errorCode: PlazaErrorCode.RecognizeAlready,
        });
      }

      await tx.collaborationRecognition.createMany({
        data: uniqueRecipientIds.map((recipientID) => ({
          recipientID,
          recognizerID: authorId,
          circlePostID: postId,
        })),
      });

      const likedOn = likedOnToday();
      const existingLikes = await tx.userLike.findMany({
        where: {
          fromUserID: authorId,
          toUserID: { in: uniqueRecipientIds },
          likedOn,
        },
        select: { toUserID: true },
      });
      const alreadyLikedUserIds = new Set(
        existingLikes.map((like) => like.toUserID),
      );
      const newLikeRecipientIds = uniqueRecipientIds.filter(
        (recipientId) => !alreadyLikedUserIds.has(recipientId),
      );
      if (newLikeRecipientIds.length > 0) {
        await tx.userLike.createMany({
          data: newLikeRecipientIds.map((toUserID) => ({
            fromUserID: authorId,
            toUserID,
            likedOn,
          })),
          skipDuplicates: true,
        });
        await tx.user.updateMany({
          where: { id: { in: newLikeRecipientIds } },
          data: { receivedLikeCount: { increment: 1 } },
        });
      }

      return {
        count: uniqueRecipientIds.length,
        recognizedUserIds: uniqueRecipientIds,
      };
    });

    // After commit: a new recognition can change a recipient's TOP_COLLABORATOR
    // eligibility, which IconService caches for 30s. Drop their cache and push a
    // fresh profile summary so the badge appears immediately. Best-effort and
    // non-blocking: a slow realtime channel must not hold the HTTP response open
    // after the recognition has already been committed.
    for (const recipientId of result.recognizedUserIds) {
      try {
        this.iconService.invalidateDisplayIconCacheFor(recipientId);
        void Promise.resolve(
          this.realtime.broadcastUserProfileSummary(recipientId),
        ).catch((error) => {
          this.logger.error(
            `collaboration recognition profile refresh failed (user=${recipientId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

        // Tell the recognized collaborator they were recognized. Recognition is
        // already committed, so this is best-effort: a notification/push failure
        // must not fail the request. Broadcast is fire-and-forget.
        const notification =
          await this.notificationService.createCollaborationRecognitionNotification(
            { toUserId: recipientId, fromUserId: authorId, postId },
          );
        if (notification) {
          this.realtime.broadcastNotificationCreated(recipientId, notification);
        }
      } catch (error) {
        this.logger.error(
          `collaboration recognition notify failed (user=${recipientId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }

  /**
   * Total unseen signups across the author's posts that still surface in the
   * 报名管理 list — active posts, plus ended posts still pending collaboration
   * recognition — so the red dot matches what the author can actually act on.
   */
  async getMySignupsUnreadCount(authorId: string): Promise<{ count: number }> {
    const count = await this.prisma.circlePostSignup.count({
      where: {
        seenByAuthor: false,
        post: {
          authorID: authorId,
          OR: [
            { status: 'ACTIVE' },
            { status: 'ENDED', collaborationRecognizedAt: null },
          ],
        },
      },
    });
    return { count };
  }

  private async requireOwnPost(
    authorId: string,
    postId: string,
  ): Promise<void> {
    const post = await this.prisma.circlePost.findFirst({
      where: { id: postId, authorID: authorId },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException({
        message: 'Post not found',
        errorCode: PlazaErrorCode.PostNotFound,
      });
    }
  }

  private checkCanInteract(
    post: InteractRestrictionFields,
    viewer: ViewerEntitlements | null,
  ): boolean {
    if (!viewer) return false;

    if (post.vipRestriction != null && viewer.vipLevel < post.vipRestriction) {
      return false;
    }
    if (
      post.creditRestriction != null &&
      viewer.creditScore < post.creditRestriction
    ) {
      return false;
    }
    if (post.fancyRestriction && !viewer.fancyNumber) {
      return false;
    }
    return true;
  }

  private checkCanSignup(
    post: SignupRestrictionFields,
    viewer: ViewerEntitlements | null,
  ): boolean {
    if (!viewer) return false;
    if (
      post.signupVipRestriction != null &&
      viewer.vipLevel < post.signupVipRestriction
    ) {
      return false;
    }
    if (
      post.signupCreditRestriction != null &&
      viewer.creditScore < post.signupCreditRestriction
    ) {
      return false;
    }
    if (post.signupFancyRestriction && !viewer.fancyNumber) {
      return false;
    }
    return true;
  }

  private async getDisplayIconsByAuthorIds(
    authorIds: string[],
  ): Promise<Map<string, DisplayIconDto[]>> {
    const uniqueAuthorIds = [...new Set(authorIds.filter(Boolean))];
    if (uniqueAuthorIds.length === 0) return new Map();

    try {
      // Single batched resolution avoids an N+1 (one query set for all authors
      // instead of ~5 queries per author).
      return await this.iconService.getDisplayIconsForUsers(uniqueAuthorIds);
    } catch {
      // Icons are non-critical chrome — never fail the feed over them. Callers
      // fall back to an empty list per author on a missing entry.
      this.logger.warn(
        `failed to resolve display icons for plaza authors: ${uniqueAuthorIds.join(
          ', ',
        )}`,
      );
      return new Map();
    }
  }

  private toPlazaPostDto(
    post: PlazaPostWithRelations,
    canInteract: boolean,
    signedByMe: boolean,
    canSignup: boolean,
    displayIcons: DisplayIconDto[],
  ): PlazaPostDto {
    return {
      id: post.id,
      content: post.content,
      images: post.images,
      tags: post.tags,
      city: post.city,
      cities: post.cities ?? (post.city ? [post.city] : []),
      isHorn: post.isHorn,
      noteId: post.noteID,
      restrictions: {
        vipLevel: post.vipRestriction,
        creditScore: post.creditRestriction,
        fancyNumber: post.fancyRestriction,
      },
      viewCount: post.viewCount,
      signupCount: post.signupCount ?? 0,
      signedByMe,
      signupRestrictions: {
        vipLevel: post.signupVipRestriction ?? null,
        creditScore: post.signupCreditRestriction ?? null,
        fancyNumber: post.signupFancyRestriction ?? false,
      },
      canSignup,
      author: {
        id: post.author.id,
        nickname: post.author.nickname,
        avatarUrl: post.author.avatarUrl,
        avatarFrame: post.author.avatarFrame,
        accountId: post.author.accountId,
        displayIcons,
      },
      circle: {
        id: post.circle.id,
        name: post.circle.name,
      },
      // 多圈：优先用关联表；缺 circleLinks（旧 include/mock）时回落到主圈子。
      circles: post.circleLinks?.length
        ? post.circleLinks.map((link) => ({
            id: link.circle.id,
            name: link.circle.name,
          }))
        : [{ id: post.circle.id, name: post.circle.name }],
      canInteract,
      createdAt: post.createdAt.toISOString(),
      expiresAt: this.formatPostExpiresAt(post),
    };
  }

  private activeUnexpiredPostWhere(
    now = new Date(),
  ): Prisma.CirclePostWhereInput {
    const legacyCutoff = new Date(now.getTime() - CIRCLE_POST_AUTO_END_MS);

    return {
      status: 'ACTIVE',
      OR: [
        { expiresAt: { gt: now } },
        {
          expiresAt: null,
          createdAt: { gt: legacyCutoff },
        },
      ],
    };
  }

  private formatPostExpiresAt(
    post: Pick<CirclePost, 'createdAt' | 'expiresAt'>,
  ): string {
    return (
      post.expiresAt ??
      new Date(post.createdAt.getTime() + CIRCLE_POST_AUTO_END_MS)
    ).toISOString();
  }
}
