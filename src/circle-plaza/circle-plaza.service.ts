import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  CreatePlazaPostDto,
  PlazaFeedQueryDto,
  PlazaPostDto,
} from './dto/circle-plaza.dto';

@Injectable()
export class CirclePlazaService {
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
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

    return this.toPlazaPostDto(post, true, false);
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

    const where: any = { status: 'ACTIVE', circle: { deleted: false } };
    if (query.circleId) {
      where.circleID = query.circleId;
    }
    if (query.city) {
      where.city = query.city;
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
    // 报名故意不强制帖子的 VIP / 信用分 / 靓号 canInteract 限制：
    // 产品决策 —— 每个圈子帖子都能报名。
    const post = await this.prisma.circlePost.findFirst({
      where: { id: postId, status: 'ACTIVE', circle: { deleted: false } },
      select: { id: true, authorID: true, circleID: true },
    });
    if (!post) throw new NotFoundException('Post not found');

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
        await tx.circleActivity.create({
          data: {
            circleID: post.circleID,
            postID: postId,
            viewerID: userId,
            actorID: userId,
            type: 'POST_SIGNUP_CONFIRMED',
          },
        });
        if (post.authorID !== userId) {
          await tx.circleActivity.create({
            data: {
              circleID: post.circleID,
              postID: postId,
              viewerID: post.authorID,
              actorID: userId,
              type: 'POST_SIGNUP_RECEIVED',
            },
          });
        }
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

    // Broadcasts are best-effort: the signup is already persisted and the op is
    // idempotent on retry, so a realtime failure must not turn this into a 500.
    try {
      await this.realtime.broadcastCircleUnreadCount(userId);
      if (post.authorID !== userId) {
        await this.realtime.broadcastCircleUnreadCount(post.authorID);
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
        select: { signupCount: true },
      });
    });

    return { signed: false, signupCount: Math.max(0, updated.signupCount) };
  }

  async getPostSignups(postId: string): Promise<{
    items: {
      id: string;
      nickname: string;
      avatarUrl: string | null;
      accountId: string;
      signedAt: string;
    }[];
  }> {
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

  private toPlazaPostDto(
    post: any,
    canInteract: boolean,
    signedByMe: boolean,
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
