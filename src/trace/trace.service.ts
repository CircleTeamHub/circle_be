import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from 'src/notification/notification.service';
import { TraceErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { assertUrlsFromStorage } from 'src/utils/storage-url';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  CreateTraceCommentDto,
  CreateTraceDto,
  TraceCommentDto,
  TraceDto,
  TraceFeedQueryDto,
} from './dto/trace.dto';

const TRACE_FEED_LIKE_PREVIEW_LIMIT = 20;
const TRACE_FEED_COMMENT_PREVIEW_LIMIT = 20;
const TRACE_DETAIL_COMMENT_LIMIT = 100;

@Injectable()
export class TraceService {
  private readonly logger = new Logger(TraceService.name);
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly realtimeService: RealtimeService,
    private readonly privacySettings: PrivacySettingsService,
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
  }

  // ─── Feed ──────────────────────────────────────────────────────────────────

  async getFeed(
    userId: string,
    query: TraceFeedQueryDto,
  ): Promise<{
    items: TraceDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const friendIds = await this.getAcceptedFriendIds(userId);
    const friendIdSet = new Set(friendIds);
    const visibleUserIds = await this.filterMomentVisibleAuthorIds(
      userId,
      [userId, ...friendIds],
      friendIdSet,
    );

    // 单用户相册：authorId 收窄到某个作者。作者必须对 viewer 可见
    // （本人或已接受好友且未被隐私屏蔽），否则返回空——不泄露存在性。
    if (query.authorId && !visibleUserIds.includes(query.authorId)) {
      return { items: [], total: 0, page, limit, hasMore: false };
    }

    const where = {
      deleted: false,
      fromID: query.authorId ? query.authorId : { in: visibleUserIds },
      // PRIVATE is excluded for everyone but the author. PUBLIC isn't creatable
      // via CreateTraceDto (FRIENDS_ONLY | PRIVATE only) but is honored here on
      // purpose, so legacy / other-origin PUBLIC rows still surface — do not
      // drop the branch without a data backfill.
      OR: [
        { fromID: userId },
        { visibility: 'FRIENDS_ONLY' as const },
        { visibility: 'PUBLIC' as const },
      ],
    };

    const [traces, total] = await Promise.all([
      this.prisma.trace.findMany({
        where,
        include: {
          from: { select: { id: true, nickname: true, avatarUrl: true } },
          likeStats: {
            where: { deleted: false },
            orderBy: { updatedAt: 'desc' },
            take: TRACE_FEED_LIKE_PREVIEW_LIMIT,
            include: { user: { select: { id: true, nickname: true } } },
          },
          comments: {
            where: { deleted: false },
            include: {
              user: { select: { id: true, nickname: true } },
              replyTo: {
                include: { user: { select: { id: true, nickname: true } } },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: TRACE_FEED_COMMENT_PREVIEW_LIMIT,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.trace.count({ where }),
    ]);

    // Resolve the viewer's own like state from an authoritative query rather
    // than the truncated `likeStats` preview — a like outside the top-20 would
    // otherwise make `isLikedByMe` wrong.
    const myLikes = await this.prisma.traceLikeStat.findMany({
      where: {
        userID: userId,
        deleted: false,
        traceID: { in: traces.map((trace) => trace.id) },
      },
      select: { traceID: true },
    });
    const likedTraceIds = new Set(myLikes.map((like) => like.traceID));

    const items = traces.map((trace) =>
      this.toTraceDto(trace, userId, friendIdSet, likedTraceIds),
    );

    // Feed query dimensions — helps diagnose "I can't see X's moments" reports
    // (scope size vs. result count) without logging any content.
    this.logger.debug(
      `trace feed: viewer=${userId} authorId=${query.authorId ?? '-'} ` +
        `visibleAuthors=${visibleUserIds.length} page=${page} ` +
        `returned=${traces.length} total=${total}`,
    );

    return {
      items,
      total,
      page,
      limit,
      hasMore: skip + traces.length < total,
    };
  }

  async getNewCount(userId: string, since: string): Promise<number> {
    const sinceAt = new Date(since);
    if (Number.isNaN(sinceAt.getTime())) {
      throw new BadRequestException('Invalid timestamp');
    }

    const friendIds = await this.getAcceptedFriendIds(userId);
    const visibleUserIds = await this.filterMomentVisibleAuthorIds(
      userId,
      [userId, ...friendIds],
      new Set(friendIds),
    );

    return this.prisma.trace.count({
      where: {
        deleted: false,
        fromID: { in: visibleUserIds },
        createdAt: { gt: sinceAt },
        OR: [
          { fromID: userId },
          { visibility: 'FRIENDS_ONLY' },
          { visibility: 'PUBLIC' },
        ],
      },
    });
  }

  // ─── Detail ──────────────────────────────────────────────────────────────────

  async getTraceById(userId: string, traceId: string): Promise<TraceDto> {
    // Authoritative access gate: throws NotFound (missing/deleted) or
    // Forbidden (privacy) using the exact same rules as the like/comment paths.
    await this.requireVisibleTrace(traceId, userId);

    // Re-fetch with the feed's relation shape so the single-moment payload is
    // identical to the TraceDto the list already renders. The detail endpoint
    // uses a higher comment cap than the feed preview to avoid unbounded
    // response/DB work on hot moments.
    const trace = await this.prisma.trace.findFirst({
      where: { id: traceId, deleted: false },
      include: {
        from: { select: { id: true, nickname: true, avatarUrl: true } },
        likeStats: {
          where: { deleted: false },
          orderBy: { updatedAt: 'desc' },
          take: TRACE_FEED_LIKE_PREVIEW_LIMIT,
          include: { user: { select: { id: true, nickname: true } } },
        },
        comments: {
          where: { deleted: false },
          include: {
            user: { select: { id: true, nickname: true } },
            replyTo: {
              include: { user: { select: { id: true, nickname: true } } },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: TRACE_DETAIL_COMMENT_LIMIT,
        },
      },
    });

    // requireVisibleTrace already proved it exists; this only guards the narrow
    // window where it was soft-deleted between the two reads.
    if (!trace) {
      throw new NotFoundException({
        message: 'Moment not found',
        errorCode: TraceErrorCode.MomentNotFound,
      });
    }

    const friendIdSet = new Set(await this.getAcceptedFriendIds(userId));

    // Authoritative own-like state — the likeStats preview above is truncated.
    const myLike = await this.prisma.traceLikeStat.findFirst({
      where: { traceID: traceId, userID: userId, deleted: false },
      select: { traceID: true },
    });
    const likedTraceIds = new Set(myLike ? [traceId] : []);

    return this.toTraceDto(trace, userId, friendIdSet, likedTraceIds);
  }

  // ─── Create / Delete ───────────────────────────────────────────────────────

  async createTrace(userId: string, dto: CreateTraceDto): Promise<TraceDto> {
    assertUrlsFromStorage(dto.images ?? [], this.minioPublicUrl, 'trace image');

    const trace = await this.prisma.trace.create({
      data: {
        content: dto.content,
        images: dto.images ?? [],
        visibility: dto.visibility ?? 'FRIENDS_ONLY',
        type: 'MOMENT',
        fromID: userId,
      },
      include: {
        from: { select: { id: true, nickname: true, avatarUrl: true } },
      },
    });

    return {
      id: trace.id,
      content: trace.content,
      images: trace.images,
      visibility: trace.visibility,
      author: {
        id: trace.from.id,
        nickname: trace.from.nickname,
        avatarUrl: trace.from.avatarUrl,
      },
      likeCount: 0,
      commentCount: 0,
      isLikedByMe: false,
      likedFriends: [],
      comments: [],
      createdAt: trace.createdAt.toISOString(),
    };
  }

  async deleteTrace(userId: string, traceId: string): Promise<void> {
    const trace = await this.prisma.trace.findFirst({
      where: { id: traceId, deleted: false },
    });
    if (!trace) {
      throw new NotFoundException({
        message: 'Moment not found',
        errorCode: TraceErrorCode.MomentNotFound,
      });
    }
    if (trace.fromID !== userId) {
      throw new ForbiddenException({
        message: 'Only the author can delete',
        errorCode: TraceErrorCode.DeleteAuthorOnly,
      });
    }
    // Include fromID + deleted in the write to close the TOCTOU window.
    await this.prisma.trace.update({
      where: { id: traceId, fromID: userId, deleted: false },
      data: { deleted: true },
    });
  }

  // ─── Like ──────────────────────────────────────────────────────────────────

  async toggleLike(
    userId: string,
    traceId: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    const trace = await this.requireVisibleTrace(traceId, userId);

    // The read-decide-write must be one atomic unit: a plain check-then-write
    // let two concurrent toggles both increment likeCount. Serializable +
    // retry serializes them, and the like row's own lookup happens inside.
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const existing = await tx.traceLikeStat.findUnique({
        where: { traceID_userID: { traceID: traceId, userID: userId } },
      });

      let liked: boolean;
      let delta: number;

      if (existing) {
        // `deleted` is the soft-unlike flag — currently-deleted means a
        // toggle now *likes* it.
        liked = existing.deleted;
        delta = liked ? 1 : -1;
        await tx.traceLikeStat.update({
          where: { id: existing.id },
          data: { deleted: !liked },
        });
      } else {
        liked = true;
        delta = 1;
        await tx.traceLikeStat.create({
          data: { traceID: traceId, userID: userId },
        });
      }

      const updated = await tx.trace.update({
        where: { id: traceId },
        data: { likeCount: { increment: delta } },
        select: { likeCount: true },
      });

      return { liked, likeCount: updated.likeCount };
    });

    if (result.liked) {
      try {
        const notification =
          await this.notificationService.createTraceLikeNotification({
            actorId: userId,
            traceId,
            traceOwnerId: trace.fromID,
          });
        if (notification) {
          await this.realtimeService.broadcastInteractionUnread(trace.fromID);
          this.realtimeService.broadcastNotificationCreated(
            trace.fromID,
            notification,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Trace like notification side effect failed: ${userId} -> ${trace.fromID} (${traceId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }

  // ─── Comment ───────────────────────────────────────────────────────────────

  async addComment(
    userId: string,
    traceId: string,
    dto: CreateTraceCommentDto,
  ): Promise<TraceCommentDto> {
    const trace = await this.requireVisibleTrace(traceId, userId);

    if (dto.replyToId) {
      const replyTarget = await this.prisma.traceComment.findFirst({
        where: { id: dto.replyToId, deleted: false },
        select: { id: true, traceID: true },
      });
      if (!replyTarget) {
        throw new BadRequestException({
          message: 'Reply target not found',
          errorCode: TraceErrorCode.ReplyTargetNotFound,
        });
      }
      if (replyTarget.traceID !== traceId) {
        throw new BadRequestException(
          'Reply target must belong to the same trace',
        );
      }
    }

    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.traceComment.create({
        data: {
          content: dto.content,
          traceID: traceId,
          userID: userId,
          replyToID: dto.replyToId ?? null,
          parentID: dto.replyToId ?? null,
        },
        include: {
          user: { select: { id: true, nickname: true } },
          replyTo: {
            include: { user: { select: { id: true, nickname: true } } },
          },
        },
      });

      await tx.trace.update({
        where: { id: traceId },
        data: { replyCount: { increment: 1 } },
      });

      return created;
    });

    try {
      const createdNotifications =
        await this.notificationService.createTraceCommentNotifications({
          actorId: userId,
          traceId,
          commentId: comment.id,
          traceOwnerId: trace.fromID,
          replyToCommentId: comment.replyTo?.id ?? null,
          replyToUserId: comment.replyTo?.user.id ?? null,
          content: comment.content,
        });

      await Promise.all(
        createdNotifications.map(async ({ targetUserId, notification }) => {
          await this.realtimeService.broadcastInteractionUnread(targetUserId);
          this.realtimeService.broadcastNotificationCreated(
            targetUserId,
            notification,
          );
          this.realtimeService.broadcastCirclePostInteractionCreated(
            targetUserId,
            {
              traceId,
              commentId: comment.id,
              interactionType: comment.replyTo ? 'REPLY' : 'COMMENT',
              actorId: userId,
              actorNickname: comment.user.nickname,
            },
          );
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Trace comment notification side effect failed: ${userId} on ${traceId}/${comment.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      id: comment.id,
      content: comment.content,
      user: { id: comment.user.id, nickname: comment.user.nickname },
      replyTo: comment.replyTo
        ? {
            // Parent COMMENT id (the client threads replies by this), not the
            // replied-to user id. `nickname` is the replied-to user.
            id: comment.replyTo.id,
            nickname: comment.replyTo.user.nickname,
          }
        : null,
      createdAt: comment.createdAt.toISOString(),
    };
  }

  async deleteComment(userId: string, commentId: string): Promise<void> {
    const comment = await this.prisma.traceComment.findFirst({
      where: { id: commentId, deleted: false },
    });
    if (!comment) {
      throw new NotFoundException({
        message: 'Comment not found',
        errorCode: TraceErrorCode.CommentNotFound,
      });
    }
    if (comment.userID !== userId) {
      throw new ForbiddenException({
        message: 'Only the author can delete',
        errorCode: TraceErrorCode.DeleteAuthorOnly,
      });
    }

    await this.prisma.$transaction([
      this.prisma.traceComment.update({
        where: { id: commentId },
        data: { deleted: true },
      }),
      this.prisma.trace.update({
        where: { id: comment.traceID },
        data: { replyCount: { decrement: 1 } },
      }),
    ]);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async getAcceptedFriendIds(userId: string): Promise<string[]> {
    const records = await this.prisma.friend.findMany({
      where: {
        OR: [{ userID: userId }, { friendID: userId }],
        state: 'ACCEPTED',
      },
      select: { userID: true, friendID: true },
    });
    return records.map((r) => (r.userID === userId ? r.friendID : r.userID));
  }

  private async filterMomentVisibleAuthorIds(
    viewerId: string,
    authorIds: string[],
    friendIdSet: Set<string>,
  ): Promise<string[]> {
    // One settings query for all authors instead of one per author (was an
    // O(friends) N+1 on every feed page).
    const settingsByAuthor =
      await this.privacySettings.getSettingsMany(authorIds);
    return authorIds.filter((authorId) =>
      this.privacySettings.momentsVisibleFor(
        settingsByAuthor.get(authorId),
        authorId === viewerId,
        friendIdSet.has(authorId),
      ),
    );
  }

  private async requireVisibleTrace(traceId: string, viewerId: string) {
    const trace = await this.prisma.trace.findFirst({
      where: { id: traceId, deleted: false },
    });
    if (!trace) {
      throw new NotFoundException({
        message: 'Moment not found',
        errorCode: TraceErrorCode.MomentNotFound,
      });
    }
    if (trace.fromID === viewerId) {
      return trace;
    }
    const friendIds =
      trace.visibility === 'FRIENDS_ONLY' || trace.visibility === 'PUBLIC'
        ? await this.getAcceptedFriendIds(viewerId)
        : [];
    const isFriend = friendIds.includes(trace.fromID);
    const authorAllowsViewer = await this.privacySettings.canViewMoments(
      trace.fromID,
      false,
      isFriend,
    );
    if (!authorAllowsViewer) {
      throw new ForbiddenException({
        message: 'You are not allowed to access this moment',
        errorCode: TraceErrorCode.AccessForbidden,
      });
    }
    if (trace.visibility === 'PUBLIC') {
      return trace;
    }
    if (trace.visibility === 'FRIENDS_ONLY') {
      if (isFriend) {
        return trace;
      }
    }

    throw new ForbiddenException({
      message: 'You are not allowed to access this moment',
      errorCode: TraceErrorCode.AccessForbidden,
    });
  }

  private toTraceDto(
    trace: any,
    viewerId: string,
    friendIdSet: Set<string>,
    likedTraceIds: Set<string>,
  ): TraceDto {
    // Filter likes and comments to only show mutual friends (WeChat Moments logic)
    const mutualLikes = trace.likeStats
      .filter(
        (ls: any) =>
          ls.userID === viewerId ||
          ls.userID === trace.fromID ||
          friendIdSet.has(ls.userID),
      )
      .map((ls: any) => ({
        id: ls.user.id,
        nickname: ls.user.nickname,
      }));

    const mutualComments = [...trace.comments]
      .reverse()
      .filter(
        (c: any) =>
          c.userID === viewerId ||
          c.userID === trace.fromID ||
          friendIdSet.has(c.userID),
      )
      .map(
        (c: any): TraceCommentDto => ({
          id: c.id,
          content: c.content,
          user: { id: c.user.id, nickname: c.user.nickname },
          // `id` MUST be the parent COMMENT id — the client threads replies by
          // looking it up in a comment-id map. Using c.replyTo.user.id here made
          // every reply look like its own root → flat, unthreaded comment list.
          replyTo:
            c.replyTo && c.replyTo.user
              ? { id: c.replyTo.id, nickname: c.replyTo.user.nickname }
              : null,
          createdAt: c.createdAt.toISOString(),
        }),
      );

    // Authoritative — not derived from the truncated likeStats preview.
    const isLikedByMe = likedTraceIds.has(trace.id);

    return {
      id: trace.id,
      content: trace.content,
      images: trace.images,
      visibility: trace.visibility,
      author: {
        id: trace.from.id,
        nickname: trace.from.nickname,
        avatarUrl: trace.from.avatarUrl,
      },
      likeCount: trace.likeCount,
      commentCount: trace.replyCount,
      isLikedByMe,
      likedFriends: mutualLikes,
      comments: mutualComments,
      createdAt: trace.createdAt.toISOString(),
    };
  }
}
