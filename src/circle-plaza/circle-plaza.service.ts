import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CirclePost, Prisma, User } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { OpenimService } from 'src/openim/openim.service';
import { NotificationService } from 'src/notification/notification.service';
import { IconService } from 'src/icon/icon.service';
import {
  CreatePlazaPostDto,
  MyCirclePostDto,
  PlazaFeedQueryDto,
  PlazaPostDto,
  PostSignupItemDto,
} from './dto/circle-plaza.dto';

// A plaza post joined with the relations every DTO mapping needs.
type PlazaPostWithRelations = Prisma.CirclePostGetPayload<{
  include: { author: true; circle: true };
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
const MIN_SIGNUPS_FOR_COLLABORATION_RECOGNITION = 3;
const CIRCLE_POST_AUTO_END_MS = 24 * 60 * 60 * 1000;
const CIRCLE_POST_AUTO_END_BATCH_SIZE = 100;
const DEFAULT_CIRCLE_POST_EXPIRY_HOURS = 24;

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
    // Verify circle exists and user is a member
    const membership = await this.prisma.circleMember.findUnique({
      where: {
        userID_circleID: { userID: userId, circleID: dto.circleId },
      },
      include: { circle: true },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException(
        'You must be an active member of the circle to post',
      );
    }
    if (membership.circle.deleted) {
      throw new NotFoundException('Circle not found');
    }

    this.assertImagesAreSafe(dto.images);

    // Check if members are allowed to post (owners/admins always can)
    if (!membership.circle.memberCanPost && membership.role === 'MEMBER') {
      throw new ForbiddenException('该圈子仅管理员可以发帖');
    }

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
        throw new BadRequestException(
          'Note not found, unavailable, or not owned by the current user',
        );
      }
    }

    const expiresInHours =
      dto.expiresInHours ?? DEFAULT_CIRCLE_POST_EXPIRY_HOURS;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const post = await this.prisma.$transaction(async (tx) => {
      const created = await tx.circlePost.create({
        data: {
          content: dto.content,
          images: dto.images ?? [],
          tags: dto.tags ?? [],
          city: dto.city ?? null,
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
          circleID: dto.circleId,
        },
        include: {
          author: true,
          circle: true,
        },
      });

      await tx.circle.update({
        where: { id: dto.circleId },
        data: { postCount: { increment: 1 } },
      });

      return created;
    });

    return this.toPlazaPostDto(post, true, false, true);
  }

  async getFeed(
    viewerId: string,
    query: PlazaFeedQueryDto,
  ): Promise<{
    items: PlazaPostDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.CirclePostWhereInput = {
      ...this.activeUnexpiredPostWhere(),
      circle: {
        deleted: false,
        members: {
          some: { userID: viewerId, status: 'ACTIVE' },
        },
      },
    };
    const circleIds = this.parseCommaList(query.circleIds);
    const cities = this.parseCommaList(query.cities);

    if (query.circleId) {
      where.circleID = query.circleId;
    } else if (circleIds.length > 0) {
      where.circleID = { in: circleIds };
    }
    if (query.city) {
      where.city = query.city;
    } else if (cities.length > 0) {
      where.city = { in: cities };
    }

    const [posts, total, viewer] = await Promise.all([
      this.prisma.circlePost.findMany({
        where,
        include: {
          author: true,
          circle: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.circlePost.count({ where }),
      this.prisma.user.findUnique({
        where: { id: viewerId },
        select: { vipLevel: true, creditScore: true, fancyNumber: true },
      }),
    ]);

    const postIds = posts.map((p) => p.id);
    const mySignups = postIds.length
      ? await this.prisma.circlePostSignup.findMany({
          where: { userID: viewerId, postID: { in: postIds } },
          select: { postID: true },
        })
      : [];
    const signedSet = new Set(mySignups.map((s) => s.postID));

    const items = posts.map((post) =>
      this.toPlazaPostDto(
        post,
        this.checkCanInteract(post, viewer),
        signedSet.has(post.id),
        this.checkCanSignup(post, viewer),
      ),
    );

    this.logger.debug(
      `plaza feed: viewer=${viewerId} ` +
        `circleFilter=${query.circleId ?? circleIds.length} ` +
        `cityFilter=${query.city ?? cities.length} page=${page} ` +
        `returned=${posts.length} total=${total}`,
    );

    return {
      items,
      total,
      page,
      limit,
      hasMore: skip + posts.length < total,
    };
  }

  async getPost(viewerId: string, postId: string): Promise<PlazaPostDto> {
    const [post, viewer] = await Promise.all([
      this.prisma.circlePost.findFirst({
        where: {
          ...this.activeUnexpiredPostWhere(),
          id: postId,
          circle: { deleted: false },
        },
        include: { author: true, circle: true },
      }),
      this.prisma.user.findUnique({
        where: { id: viewerId },
        select: { vipLevel: true, creditScore: true, fancyNumber: true },
      }),
    ]);

    if (!post) throw new NotFoundException('Post not found');

    const signed = await this.prisma.circlePostSignup.findUnique({
      where: { postID_userID: { postID: postId, userID: viewerId } },
      select: { id: true },
    });

    return this.toPlazaPostDto(
      post,
      this.checkCanInteract(post, viewer),
      Boolean(signed),
      this.checkCanSignup(post, viewer),
    );
  }

  async deletePost(userId: string, postId: string): Promise<void> {
    const post = await this.prisma.circlePost.findFirst({
      where: { ...this.activeUnexpiredPostWhere(), id: postId },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorID !== userId) {
      throw new ForbiddenException('Only the author can delete this post');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.circlePost.update({
        where: { id: postId },
        data: { status: 'DELETED' },
      });

      await tx.circle.update({
        where: { id: post.circleID },
        data: { postCount: { decrement: 1 } },
      });
    });
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
        circle: { deleted: false },
      },
      select: {
        id: true,
        authorID: true,
        circleID: true,
        signupVipRestriction: true,
        signupCreditRestriction: true,
        signupFancyRestriction: true,
      },
    });
    if (!post) throw new NotFoundException('Post not found');

    // The author manages signups for their own post and never signs up for it.
    if (post.authorID === userId) {
      throw new ForbiddenException('不能给自己发布的帖子报名');
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

    // 报名资格校验（独立于帖子查看限制 vipRestriction，仅看 signup* 门槛）
    const viewer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipLevel: true, creditScore: true, fancyNumber: true },
    });
    if (!this.checkCanSignup(post, viewer)) {
      throw new ForbiddenException('您的等级不满足该帖子的报名要求');
    }

    let updated: { signupCount: number };
    try {
      updated = await this.prisma.$transaction(async (tx) => {
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
    const existing = await this.prisma.circlePostSignup.findUnique({
      where: { postID_userID: { postID: postId, userID: userId } },
      select: { id: true },
    });
    if (!existing) {
      const current = await this.prisma.circlePost.findUnique({
        where: { id: postId },
        select: { signupCount: true },
      });
      return { signed: false, signupCount: current?.signupCount ?? 0 };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.circlePostSignup.delete({
        where: { postID_userID: { postID: postId, userID: userId } },
      });
      return tx.circlePost.update({
        where: { id: postId },
        data: { signupCount: { decrement: 1 } },
        select: { signupCount: true, authorID: true },
      });
    });

    // Cancelling can drop an unseen signup, so refresh the author's badge.
    try {
      await this.realtime.broadcastSignupUnread(updated.authorID);
    } catch {
      // swallow: write is authoritative
    }

    return { signed: false, signupCount: Math.max(0, updated.signupCount) };
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

  /** Signers of one of the author's own posts, with identity for opening a chat. */
  async getMyPostSignups(
    authorId: string,
    postId: string,
  ): Promise<{ items: PostSignupItemDto[] }> {
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
        userId: s.user.id,
        imUserId: OpenimService.toImUserId(s.user.id),
        nickname: s.user.nickname,
        avatarUrl: s.user.avatarUrl,
        accountId: s.user.accountId,
        signedAt: s.createdAt.toISOString(),
        seen: s.seenByAuthor,
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
      throw new BadRequestException('Select at least one collaborator');
    }
    if (uniqueRecipientIds.length > MAX_COLLABORATION_RECOGNITIONS_PER_POST) {
      throw new BadRequestException('Select at most three collaborators');
    }
    if (uniqueRecipientIds.includes(authorId)) {
      throw new ForbiddenException('Cannot recognize yourself');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const post = await tx.circlePost.findFirst({
        where: {
          id: postId,
          authorID: authorId,
          status: { in: ['ACTIVE', 'ENDED'] },
        },
        select: { id: true, authorID: true, circleID: true },
      });
      if (!post) throw new NotFoundException('Post not found');

      const signupCount = await tx.circlePostSignup.count({
        where: { postID: postId },
      });
      if (signupCount < MIN_SIGNUPS_FOR_COLLABORATION_RECOGNITION) {
        throw new BadRequestException(
          'At least three signups are required before recognizing collaborators',
        );
      }

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
        throw new BadRequestException(
          'Only users who signed up for the post can be recognized',
        );
      }

      const activeMembers = await tx.circleMember.findMany({
        where: {
          circleID: post.circleID,
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
        throw new BadRequestException(
          'Only active members of the circle can be recognized',
        );
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
        throw new ForbiddenException('Cannot recognize a blocked user');
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
        throw new BadRequestException(
          'Collaboration recognition has already been submitted',
        );
      }

      await tx.collaborationRecognition.createMany({
        data: uniqueRecipientIds.map((recipientID) => ({
          recipientID,
          recognizerID: authorId,
          circlePostID: postId,
        })),
      });

      return {
        count: uniqueRecipientIds.length,
        recognizedUserIds: uniqueRecipientIds,
      };
    });

    // After commit: a new recognition can change a recipient's TOP_COLLABORATOR
    // eligibility, which IconService caches for 30s. Drop their cache and push a
    // fresh profile summary so the badge appears immediately. Best-effort: a
    // failure here must not fail the recognition that already succeeded.
    for (const recipientId of result.recognizedUserIds) {
      try {
        this.iconService.invalidateDisplayIconCacheFor(recipientId);
        await this.realtime.broadcastUserProfileSummary(recipientId);
      } catch (error) {
        this.logger.error(
          `collaboration recognition profile refresh failed (user=${recipientId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }

  /** Total unseen signups across the author's active posts (报名管理 red dot). */
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
    if (!post) throw new NotFoundException('Post not found');
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

  private toPlazaPostDto(
    post: PlazaPostWithRelations,
    canInteract: boolean,
    signedByMe: boolean,
    canSignup: boolean,
  ): PlazaPostDto {
    return {
      id: post.id,
      content: post.content,
      images: post.images,
      tags: post.tags,
      city: post.city,
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
      },
      circle: {
        id: post.circle.id,
        name: post.circle.name,
      },
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
