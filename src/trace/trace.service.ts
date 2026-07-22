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
  decodeFeedCursor,
  encodeFeedCursor,
  feedCursorWhere,
} from 'src/utils/feed-cursor';
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

/**
 * Trace-feed keyset cursor — thin wrappers over the shared feed-cursor util so
 * the 400 carries this feed's stable errorCode. Exported for the spec and for
 * clients of the service that build cursors in tests.
 */
export function encodeTraceCursor(createdAt: Date, id: string): string {
  return encodeFeedCursor(createdAt, id);
}

export function decodeTraceCursor(cursor: string): {
  createdAt: Date;
  id: string;
} {
  return decodeFeedCursor(cursor, TraceErrorCode.InvalidCursor);
}

const MOMENTS_POKE_FANOUT_PAGE = 500;
// per-author 抑制窗口：窗口内的连发合并成「领先沿立即发 + 尾随补一发」。
// 高好友数账号连发时，扇出成本从每次变更一趟降到每窗口至多两趟。
const MOMENTS_POKE_COALESCE_MS = 2_000;
// 抑制表防泄漏阈值：超过即清理已过窗口的闲置项（in-memory、per-instance）。
const MOMENTS_POKE_COALESCE_MAX_ENTRIES = 10_000;
// 绝对上限（20 页）：防御性护栏，防止病态数据把发布路径拖进长循环。
// 命中即告警 —— 超过 1 万可见好友的号需要产品层面重新设计，而不是静默截断。
const MOMENTS_POKE_MAX_PAGES = 20;

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
    total: number | null;
    page: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    // Keyset (cursor) pagination is the preferred path: cost is O(limit)
    // regardless of depth and it runs no per-page count(). Offset (page) is
    // kept for backward compatibility with clients not yet migrated. Both paths
    // return `nextCursor`, so a client can follow the cursor even if it started
    // on page numbers.
    const cursor = query.cursor ? decodeTraceCursor(query.cursor) : null;
    const useKeyset = cursor !== null;
    const skip = useKeyset ? 0 : (page - 1) * limit;

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
      return {
        items: [],
        total: useKeyset ? null : 0,
        page,
        limit,
        hasMore: false,
        nextCursor: null,
      };
    }

    const whereBase = {
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
    // (createdAt, id) tuple keyset — see feedCursorWhere for the semantics.
    const where = cursor
      ? { AND: [whereBase, feedCursorWhere(cursor)] }
      : whereBase;

    // Keyset fetches one extra row to decide `hasMore` without a count();
    // offset still returns an accurate `total` for the legacy page-number UI.
    const [rows, total] = await Promise.all([
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(useKeyset ? { take: limit + 1 } : { skip, take: limit }),
      }),
      useKeyset
        ? Promise.resolve<number | null>(null)
        : this.prisma.trace.count({ where }),
    ]);

    const hasMore = useKeyset
      ? rows.length > limit
      : skip + rows.length < (total ?? 0);
    const traces = useKeyset ? rows.slice(0, limit) : rows;

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

    // The next page starts strictly after the last returned row. Only emit a
    // cursor when there is more to fetch, so the client stops on `null`.
    const last = traces[traces.length - 1];
    const nextCursor =
      hasMore && last ? encodeTraceCursor(last.createdAt, last.id) : null;

    // Feed query dimensions — helps diagnose "I can't see X's moments" reports
    // (scope size vs. result count) without logging any content.
    this.logger.debug(
      `trace feed: viewer=${userId} authorId=${query.authorId ?? '-'} ` +
        `mode=${useKeyset ? 'keyset' : 'offset'} ` +
        `visibleAuthors=${visibleUserIds.length} page=${page} ` +
        `returned=${traces.length} total=${total ?? '-'}`,
    );

    return { items, total, page, limit, hasMore, nextCursor };
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

    // #89：发布即向可见范围广播 feed poke，客户端由 30s 轮询改为事件驱动。
    // fire-and-forget —— 广播失败绝不能反过来让发布报错。
    this.queueFeedPoke(userId, trace.visibility !== 'PRIVATE');

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

  /**
   * 朋友圈 feed 变更 poke（#89）：作者本人各端恒收；非 PRIVATE 时扇出到
   * 已接受好友中**通过 feed 同款隐私门**（momentsVisibility + 作者侧
   * CHAT_ONLY）的那些。扇出封顶 + 命中记日志（镜像圈子发帖通知的护栏哲学）；
   * includeFriends=false（PRIVATE）只 poke 自己。客户端收到后自行 refetch，内容级过滤仍由
   * GET /trace/feed 权威裁决 —— poke 无内容，但收没收到本身也不能泄密。
   */
  // review（P2 削峰）：per-author 领先沿 + 尾随合并。窗口内多次变更只触发
  // 头尾两次扇出；尾随一发聚合窗口内的最宽可见性（有任一非 PRIVATE 就扇出
  // 好友）。in-memory、per-instance —— 目的是削峰，不追求跨实例精确一次。
  private readonly pokeCoalesce = new Map<
    string,
    {
      lastRunAt: number;
      timer: ReturnType<typeof setTimeout> | null;
      pendingIncludeFriends: boolean;
    }
  >();

  private queueFeedPoke(authorId: string, includeFriends: boolean): void {
    const now = Date.now();
    let entry = this.pokeCoalesce.get(authorId);
    if (!entry) {
      if (this.pokeCoalesce.size >= MOMENTS_POKE_COALESCE_MAX_ENTRIES) {
        for (const [key, value] of this.pokeCoalesce) {
          if (
            !value.timer &&
            now - value.lastRunAt > MOMENTS_POKE_COALESCE_MS
          ) {
            this.pokeCoalesce.delete(key);
          }
        }
      }
      entry = { lastRunAt: 0, timer: null, pendingIncludeFriends: false };
      this.pokeCoalesce.set(authorId, entry);
    }

    if (entry.timer) {
      // 已有尾随发排队：只聚合可见性。
      entry.pendingIncludeFriends ||= includeFriends;
      return;
    }

    if (now - entry.lastRunAt >= MOMENTS_POKE_COALESCE_MS) {
      entry.lastRunAt = now;
      void this.broadcastFeedPoke(authorId, includeFriends);
      return;
    }

    entry.pendingIncludeFriends = includeFriends;
    const timer = setTimeout(
      () => {
        entry.timer = null;
        entry.lastRunAt = Date.now();
        const aggregated = entry.pendingIncludeFriends;
        entry.pendingIncludeFriends = false;
        void this.broadcastFeedPoke(authorId, aggregated);
      },
      MOMENTS_POKE_COALESCE_MS - (now - entry.lastRunAt),
    );
    // 不拖住进程退出（也避免测试挂 open handle）。
    timer.unref?.();
    entry.timer = timer;
  }

  private async broadcastFeedPoke(
    authorId: string,
    includeFriends: boolean,
  ): Promise<void> {
    try {
      const recipients = new Set<string>([authorId]);
      if (includeFriends) {
        // PR #122 review（P2 两条）：
        // 1. 扇出套用与 GET /trace/feed 相同的隐私门（momentsVisibleFor +
        //    作者侧 CHAT_ONLY）—— poke 虽无内容，收没收到本身也是元数据。
        // 2. 扇出读取（设置/好友表）失败不得连坐作者：内层 try 只包扇出，
        //    作者本人多端的 poke 永远送达。
        try {
          const authorSettings = (
            await this.privacySettings.getSettingsMany([authorId])
          ).get(authorId);
          // poke 候选全是已接受好友（isFriend 恒真）；作者把朋友圈对好友
          // 整体关闭时直接零扇出，只 poke 作者自己的多端。
          const visibleToFriends = this.privacySettings.momentsVisibleFor(
            authorSettings,
            false,
            true,
          );
          if (visibleToFriends) {
            // 分页全量扇出（review：硬截断会让 500 名之后的好友永远收不到
            // poke，而客户端已不再轮询）。按主键游标翻页，护栏见常量注释。
            let cursor: string | undefined;
            for (let page = 0; page < MOMENTS_POKE_MAX_PAGES; page += 1) {
              const friendships = await this.prisma.friend.findMany({
                where: {
                  state: 'ACCEPTED',
                  OR: [{ userID: authorId }, { friendID: authorId }],
                },
                select: {
                  id: true,
                  userID: true,
                  friendID: true,
                  permissionA: true,
                  permissionB: true,
                },
                orderBy: { id: 'asc' },
                take: MOMENTS_POKE_FANOUT_PAGE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
              });
              for (const friendship of friendships) {
                // 与 feed 一致：作者侧权限 CHAT_ONLY 的好友看不到其朋友圈。
                const authorPermission =
                  friendship.userID === authorId
                    ? friendship.permissionA
                    : friendship.permissionB;
                if (authorPermission === 'CHAT_ONLY') {
                  continue;
                }
                recipients.add(
                  friendship.userID === authorId
                    ? friendship.friendID
                    : friendship.userID,
                );
              }
              if (friendships.length < MOMENTS_POKE_FANOUT_PAGE) {
                break;
              }
              cursor = friendships[friendships.length - 1].id;
              if (page === MOMENTS_POKE_MAX_PAGES - 1) {
                this.logger.warn(
                  `moments feed poke fan-out hit the ${
                    MOMENTS_POKE_MAX_PAGES * MOMENTS_POKE_FANOUT_PAGE
                  }-row ceiling for ${authorId}; remaining friends not poked`,
                );
              }
            }
          }
        } catch (error) {
          this.logger.warn(
            `moments feed poke fan-out failed for ${authorId}; poking author only: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await this.realtimeService.safeBroadcastAll(
        [...recipients].map(
          (recipientId) => () =>
            this.realtimeService.broadcastMomentsFeedUpdated(recipientId, {
              authorId,
            }),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `moments feed poke failed for ${authorId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    // #89：删除同样触发 feed poke（好友端把这条从列表里拉掉）。
    this.queueFeedPoke(userId, trace.visibility !== 'PRIVATE');
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
    const content = dto.content?.trim() ?? '';
    const rawImages = dto.images ?? [];
    if (rawImages.some((image) => !image?.trim())) {
      throw new BadRequestException({
        message: 'Comment images cannot be blank',
        errorCode: TraceErrorCode.EmptyComment,
      });
    }
    const images = rawImages.map((image) => image.trim());
    // 允许纯图评论，但文字/图片不能同时为空。
    if (!content && images.length === 0) {
      throw new BadRequestException({
        message: 'Comment needs text or an image',
        errorCode: TraceErrorCode.EmptyComment,
      });
    }
    assertUrlsFromStorage(images, this.minioPublicUrl, 'comment image');

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
        throw new BadRequestException({
          message: 'Reply target must belong to the same trace',
          errorCode: TraceErrorCode.ReplyTargetMismatch,
        });
      }
    }

    const mentionEligibility = await this.filterVisibleMentionRecipients(
      trace,
      userId,
      dto.mentionedUserIds ?? [],
    );
    const mentionedUserIds = mentionEligibility.eligibleUserIds;

    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.traceComment.create({
        data: {
          content,
          images,
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
          mentionedUserIds,
          recheckMentionEligibility: async (recipientIds) => {
            return this.filterFreshVisibleMentionRecipients(
              traceId,
              userId,
              recipientIds,
            );
          },
          content:
            comment.content || (comment.images.length ? '评论了一张图片' : ''),
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
      images: comment.images,
      user: { id: comment.user.id, nickname: comment.user.nickname },
      replyTo: comment.replyTo
        ? {
            // Parent COMMENT id (the client threads replies by this), not the
            // replied-to user id. `nickname` is the replied-to user.
            id: comment.replyTo.id,
            nickname: comment.replyTo.user.nickname,
          }
        : null,
      ignoredMentionCount: mentionEligibility.ignoredMentionCount,
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

  private async filterFreshVisibleMentionRecipients(
    traceId: string,
    actorId: string,
    recipientIds: string[],
  ): Promise<{ traceAvailable: boolean; eligibleUserIds: string[] }> {
    const trace = await this.prisma.trace.findFirst({
      where: { id: traceId, deleted: false },
      select: { fromID: true, visibility: true },
    });
    if (!trace) {
      return { traceAvailable: false, eligibleUserIds: [] };
    }
    const result = await this.filterVisibleMentionRecipients(
      trace,
      actorId,
      recipientIds,
    );
    return { traceAvailable: true, eligibleUserIds: result.eligibleUserIds };
  }

  private async filterVisibleMentionRecipients(
    trace: { fromID: string; visibility: string },
    actorId: string,
    recipientIds: string[],
  ): Promise<{ eligibleUserIds: string[]; ignoredMentionCount: number }> {
    const distinctRecipientIds = [...new Set(recipientIds)].filter(
      (recipientId) => recipientId !== actorId,
    );
    if (distinctRecipientIds.length === 0) {
      return { eligibleUserIds: [], ignoredMentionCount: 0 };
    }

    const activeRecipients = await this.prisma.user.findMany({
      where: {
        id: { in: distinctRecipientIds },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const activeRecipientIds = new Set(
      activeRecipients.map((recipient) => recipient.id),
    );
    const nonOwnerRecipientIds = distinctRecipientIds.filter(
      (recipientId) =>
        recipientId !== trace.fromID && activeRecipientIds.has(recipientId),
    );
    const activeOwnerMentioned = activeRecipientIds.has(trace.fromID);
    if (nonOwnerRecipientIds.length === 0 || trace.visibility === 'PRIVATE') {
      const eligibleUserIds = activeOwnerMentioned ? [trace.fromID] : [];
      return {
        eligibleUserIds,
        ignoredMentionCount:
          distinctRecipientIds.length - eligibleUserIds.length,
      };
    }

    const [friendships, settingsByAuthor] = await Promise.all([
      this.prisma.friend.findMany({
        where: {
          state: 'ACCEPTED',
          OR: [
            {
              userID: trace.fromID,
              friendID: { in: nonOwnerRecipientIds },
            },
            {
              userID: { in: nonOwnerRecipientIds },
              friendID: trace.fromID,
            },
          ],
        },
        select: {
          userID: true,
          friendID: true,
          permissionA: true,
          permissionB: true,
        },
      }),
      this.privacySettings.getSettingsMany([trace.fromID]),
    ]);
    const friendshipByRecipient = new Map(
      friendships.map((friendship) => [
        friendship.userID === trace.fromID
          ? friendship.friendID
          : friendship.userID,
        friendship,
      ]),
    );
    const authorSettings = settingsByAuthor.get(trace.fromID);

    const visibleNonOwnerIds = nonOwnerRecipientIds.filter((recipientId) => {
      const friendship = friendshipByRecipient.get(recipientId);
      const isFriend = Boolean(friendship);
      const authorPermission =
        friendship?.userID === trace.fromID
          ? friendship.permissionA
          : friendship?.permissionB;
      if (authorPermission === 'CHAT_ONLY') {
        return false;
      }
      if (
        !this.privacySettings.momentsVisibleFor(authorSettings, false, isFriend)
      ) {
        return false;
      }
      return trace.visibility !== 'FRIENDS_ONLY' || isFriend;
    });
    const visibleNonOwnerSet = new Set(visibleNonOwnerIds);
    const eligibleUserIds = distinctRecipientIds.filter(
      (recipientId) =>
        (recipientId === trace.fromID && activeOwnerMentioned) ||
        visibleNonOwnerSet.has(recipientId),
    );
    return {
      eligibleUserIds,
      ignoredMentionCount: distinctRecipientIds.length - eligibleUserIds.length,
    };
  }

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
    // Authors who marked the viewer "chat-only" hide their moments from the
    // viewer regardless of the author's global setting. The viewer's own posts
    // are never gated this way.
    const chatOnlyAuthorIds = await this.getChatOnlyAuthorIdsToward(
      viewerId,
      authorIds,
    );
    return authorIds.filter(
      (authorId) =>
        !chatOnlyAuthorIds.has(authorId) &&
        this.privacySettings.momentsVisibleFor(
          settingsByAuthor.get(authorId),
          authorId === viewerId,
          friendIdSet.has(authorId),
        ),
    );
  }

  /**
   * Of the given authors, which ones granted the viewer only CHAT_ONLY access
   * (so their moments must be hidden from the viewer). The viewer is never
   * included even if passed in `authorIds`.
   */
  private async getChatOnlyAuthorIdsToward(
    viewerId: string,
    authorIds: string[],
  ): Promise<Set<string>> {
    const others = authorIds.filter((id) => id !== viewerId);
    if (others.length === 0) {
      return new Set();
    }
    const records = await this.prisma.friend.findMany({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: { in: others }, friendID: viewerId },
          { userID: viewerId, friendID: { in: others } },
        ],
      },
      select: {
        userID: true,
        friendID: true,
        permissionA: true,
        permissionB: true,
      },
    });
    const chatOnly = new Set<string>();
    for (const record of records) {
      // The author is whichever side isn't the viewer; read that side's grant.
      if (record.userID === viewerId) {
        if (record.permissionB === 'CHAT_ONLY') {
          chatOnly.add(record.friendID);
        }
      } else if (record.permissionA === 'CHAT_ONLY') {
        chatOnly.add(record.userID);
      }
    }
    return chatOnly;
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
    // A chat-only friend can never open the author's moment, even by direct id.
    const chatOnlyAuthors = await this.getChatOnlyAuthorIdsToward(viewerId, [
      trace.fromID,
    ]);
    if (chatOnlyAuthors.has(trace.fromID)) {
      throw new NotFoundException({
        message: 'Moment not found',
        errorCode: TraceErrorCode.MomentNotFound,
      });
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
          images: c.images ?? [],
          user: { id: c.user.id, nickname: c.user.nickname },
          // `id` MUST be the parent COMMENT id — the client threads replies by
          // looking it up in a comment-id map. Using c.replyTo.user.id here made
          // every reply look like its own root → flat, unthreaded comment list.
          replyTo:
            c.replyTo && c.replyTo.user
              ? { id: c.replyTo.id, nickname: c.replyTo.user.nickname }
              : null,
          ignoredMentionCount: 0,
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
