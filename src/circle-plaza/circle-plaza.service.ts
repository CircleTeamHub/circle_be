import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { OpenimService } from 'src/openim/openim.service';
import { NotificationService } from 'src/notification/notification.service';
import {
  CreatePlazaPostDto,
  MyCirclePostDto,
  PlazaFeedQueryDto,
  PlazaPostDto,
  PostSignupItemDto,
} from './dto/circle-plaza.dto';

@Injectable()
export class CirclePlazaService {
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly notificationService: NotificationService,
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

    const where: any = {
      status: 'ACTIVE',
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
        where: { id: postId, status: 'ACTIVE', circle: { deleted: false } },
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
      where: { id: postId, status: 'ACTIVE' },
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
      where: { id: postId, status: 'ACTIVE', circle: { deleted: false } },
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
    const where = { authorID: authorId, status: 'ACTIVE' as const };
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
      })),
      total,
      page: Math.max(1, page),
      limit,
      hasMore: skip + posts.length < total,
    };
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

  /** Total unseen signups across the author's active posts (报名管理 red dot). */
  async getMySignupsUnreadCount(authorId: string): Promise<{ count: number }> {
    const count = await this.prisma.circlePostSignup.count({
      where: {
        seenByAuthor: false,
        post: { authorID: authorId, status: 'ACTIVE' },
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
    post: any,
    viewer: {
      vipLevel: number;
      creditScore: number;
      fancyNumber: boolean;
    } | null,
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
    post: any,
    viewer: {
      vipLevel: number;
      creditScore: number;
      fancyNumber: boolean;
    } | null,
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
    post: any,
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
    };
  }
}
