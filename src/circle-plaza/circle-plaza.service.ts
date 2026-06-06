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

    return this.toPlazaPostDto(post, true);
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

    const items = posts.map((post) =>
      this.toPlazaPostDto(post, this.checkCanInteract(post, viewer)),
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

    return this.toPlazaPostDto(post, this.checkCanInteract(post, viewer));
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
    const post = await this.prisma.circlePost.findFirst({
      where: { id: postId, status: 'ACTIVE', circle: { deleted: false } },
      select: { id: true, authorID: true, circleID: true, content: true },
    });
    if (!post) throw new NotFoundException('Post not found');

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

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.circlePostSignup.create({
        data: { postID: postId, userID: userId },
      });
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

    await this.realtime.broadcastCircleUnreadCount(userId);
    if (post.authorID !== userId) {
      await this.realtime.broadcastCircleUnreadCount(post.authorID);
    }
    return { signed: true, signupCount: updated.signupCount };
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

  private toPlazaPostDto(post: any, canInteract: boolean): PlazaPostDto {
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
