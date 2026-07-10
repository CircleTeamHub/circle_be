import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { TraceErrorCode } from 'src/common/app-error-codes';
import {
  TraceService,
  encodeTraceCursor,
  decodeTraceCursor,
} from './trace.service';

/** Minimal Trace row in the shape `getFeed`'s include produces. */
function makeTraceRow(id: string, createdAt: Date) {
  return {
    id,
    fromID: 'friend-1',
    deleted: false,
    visibility: 'FRIENDS_ONLY',
    content: `content-${id}`,
    images: [],
    createdAt,
    from: { id: 'friend-1', nickname: 'Friend', avatarUrl: null },
    likeStats: [],
    comments: [],
  };
}

describe('TraceService', () => {
  let service: TraceService;

  const prisma = {
    trace: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    traceLikeStat: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    traceComment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    friend: {
      findMany: jest.fn(),
    },
    userPrivacySetting: {
      findMany: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(async (input: any) =>
      Array.isArray(input) ? Promise.all(input) : input(prisma),
    ),
  };
  const notificationService = {
    createTraceCommentNotifications: jest.fn(() => Promise.resolve([])),
    createTraceLikeNotification: jest.fn(),
  };
  const realtimeService = {
    broadcastInteractionUnread: jest.fn(() => Promise.resolve()),
    broadcastCirclePostInteractionCreated: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
  };
  const privacySettings = {
    canViewMoments: jest.fn(),
    // Batched feed path: getSettingsMany loads rows, momentsVisibleFor decides.
    getSettingsMany: jest.fn(),
    momentsVisibleFor: jest.fn(
      (
        settings: { momentsVisibility?: string } | undefined,
        isSelf: boolean,
        isFriend: boolean,
      ) => {
        if (isSelf) return true;
        const visibility = settings?.momentsVisibility ?? 'ALL';
        if (visibility === 'PRIVATE') return false;
        if (visibility === 'FRIENDS_ONLY') return isFriend;
        return true;
      },
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    privacySettings.canViewMoments.mockReset();
    privacySettings.canViewMoments.mockResolvedValue(true);
    privacySettings.getSettingsMany.mockReset();
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    prisma.userPrivacySetting.findMany.mockResolvedValue([]);
    notificationService.createTraceCommentNotifications.mockResolvedValue([]);
    notificationService.createTraceLikeNotification.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TraceService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
        { provide: NotificationService, useValue: notificationService },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
      ],
    }).compile();

    service = module.get(TraceService);
  });

  it('blocks liking a private trace that is not visible to the caller', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PRIVATE',
      likeCount: 0,
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(service.toggleLike('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('blocks access to a public trace when the author hides moments from the viewer', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
      likeCount: 0,
    });
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.canViewMoments.mockResolvedValue(false);

    await expect(service.toggleLike('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('getTraceById returns a single visible moment in the feed DTO shape', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hello world',
      images: [],
      likeCount: 2,
      replyCount: 1,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      from: { id: 'author-1', nickname: 'Author', avatarUrl: null },
      likeStats: [
        { userID: 'viewer-1', user: { id: 'viewer-1', nickname: 'Viewer' } },
      ],
      comments: [
        {
          id: 'comment-1',
          content: 'nice',
          userID: 'author-1',
          createdAt: new Date('2026-06-08T01:00:00.000Z'),
          user: { id: 'author-1', nickname: 'Author' },
          replyTo: null,
        },
      ],
    });
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'author-1' },
    ]);
    prisma.traceLikeStat.findFirst.mockResolvedValue({ traceID: 'trace-1' });

    const result = await service.getTraceById('viewer-1', 'trace-1');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'trace-1',
        content: 'hello world',
        likeCount: 2,
        commentCount: 1,
        isLikedByMe: true,
        author: expect.objectContaining({ id: 'author-1' }),
      }),
    );
    expect(result.comments).toHaveLength(1);
  });

  it('getTraceById caps loaded comments to protect the detail endpoint', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hello world',
      images: [],
      likeCount: 0,
      replyCount: 250,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      from: { id: 'author-1', nickname: 'Author', avatarUrl: null },
      likeStats: [],
      comments: [],
    });
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'author-1' },
    ]);
    prisma.traceLikeStat.findFirst.mockResolvedValue(null);

    await service.getTraceById('viewer-1', 'trace-1');

    const detailQuery = prisma.trace.findFirst.mock.calls[1][0];
    expect(detailQuery.include.comments.take).toBe(100);
  });

  it('getTraceById throws NotFound when the moment is missing or deleted', async () => {
    prisma.trace.findFirst.mockResolvedValue(null);

    await expect(
      service.getTraceById('viewer-1', 'trace-missing'),
    ).rejects.toThrow(NotFoundException);
  });

  it('getTraceById throws Forbidden for a private moment the viewer does not own', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PRIVATE',
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(service.getTraceById('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('getTraceById throws Forbidden when the author marked the viewer chat-only', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hidden from chat-only friends',
    });
    // author-1 (userID) granted viewer-1 (friendID) only CHAT_ONLY via permissionA.
    prisma.friend.findMany.mockResolvedValue([
      {
        userID: 'author-1',
        friendID: 'viewer-1',
        permissionA: 'CHAT_ONLY',
        permissionB: 'FULL',
      },
    ]);

    await expect(service.getTraceById('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects replying to a comment from a different trace', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceComment.findFirst.mockResolvedValue({
      id: 'comment-1',
      traceID: 'trace-2',
      deleted: false,
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(
      service.addComment('viewer-1', 'trace-1', {
        content: 'reply',
        replyToId: 'comment-1',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('addComment returns the parent COMMENT id as replyTo.id (client threads by it)', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceComment.findFirst.mockResolvedValue({
      id: 'parent-comment',
      traceID: 'trace-1',
      deleted: false,
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'reply-comment',
      content: 'a reply',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      // Prisma returns the parent comment relation; its `id` is the comment id,
      // while `user` is the replied-to author.
      replyTo: {
        id: 'parent-comment',
        user: { id: 'author-1', nickname: 'Bob' },
      },
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      content: 'a reply',
      replyToId: 'parent-comment',
    });

    // id is the parent comment id (not the author's user id 'author-1');
    // nickname is the replied-to user.
    expect(result.replyTo).toEqual({ id: 'parent-comment', nickname: 'Bob' });
  });

  it('addComment stores images and allows an image-only comment', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-img',
      content: '',
      images: ['https://cdn.example/img.jpg'],
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      images: ['https://cdn.example/img.jpg'],
    });

    expect(prisma.traceComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: '',
          images: ['https://cdn.example/img.jpg'],
        }),
      }),
    );
    expect(result.images).toEqual(['https://cdn.example/img.jpg']);
  });

  it('addComment rejects a comment with neither text nor images', async () => {
    await expect(
      service.addComment('actor-1', 'trace-1', { content: '   ' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.traceComment.create).not.toHaveBeenCalled();
  });

  it('rejects missing or inactive mentioned users before creating a comment', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([]);

    const error = await service
      .addComment('actor-1', 'trace-1', {
        content: 'hello',
        mentionedUserIds: ['mention-user-1'],
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual(
      expect.objectContaining({
        errorCode: TraceErrorCode.MentionNotVisible,
      }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['mention-user-1'] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    expect(prisma.traceComment.create).not.toHaveBeenCalled();
  });

  it('rejects mentioned users blocked by trace visibility before creating a comment', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.canViewMoments.mockResolvedValue(false);

    const error = await service
      .addComment('actor-1', 'trace-1', {
        content: 'hello',
        mentionedUserIds: ['mention-user-1'],
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual(
      expect.objectContaining({
        errorCode: TraceErrorCode.MentionNotVisible,
      }),
    );
    expect(prisma.traceComment.create).not.toHaveBeenCalled();
  });

  it('deduplicates valid mention recipients and forwards them to notifications', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 'mention-user-1' },
      { id: 'mention-user-2' },
    ]);
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.canViewMoments.mockResolvedValue(true);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: [
        'actor-1',
        'mention-user-1',
        'mention-user-1',
        'mention-user-2',
      ],
    });

    expect(
      notificationService.createTraceCommentNotifications,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        mentionedUserIds: ['mention-user-1', 'mention-user-2'],
      }),
    );
  });

  it('broadcasts the created notification payload after adding a trace comment', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});
    notificationService.createTraceCommentNotifications.mockResolvedValue([
      {
        targetUserId: 'author-1',
        notification: {
          id: 'notification-1',
          type: 'TRACE_COMMENT',
          content: 'hello',
          read: false,
          createdAt: '2026-06-08T00:00:00.000Z',
          fromUser: { id: 'actor-1', nickname: 'Alice', avatarUrl: null },
          fromTrace: { id: 'trace-1', excerpt: 'trace', firstImage: null },
          fromReply: { id: 'comment-1', content: 'hello' },
          fromCircle: null,
          fromCirclePost: null,
          fromInvitation: null,
        },
      },
    ]);

    await service.addComment('actor-1', 'trace-1', { content: 'hello' });

    expect(realtimeService.broadcastInteractionUnread).toHaveBeenCalledWith(
      'author-1',
    );
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'author-1',
      expect.objectContaining({ id: 'notification-1', type: 'TRACE_COMMENT' }),
    );
  });

  it('does not fail an added trace comment when notification delivery fails', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});
    notificationService.createTraceCommentNotifications.mockRejectedValue(
      new Error('notification unavailable'),
    );

    await expect(
      service.addComment('actor-1', 'trace-1', { content: 'hello' }),
    ).resolves.toEqual(
      expect.objectContaining({ id: 'comment-1', content: 'hello' }),
    );
  });

  it('caps embedded likes and comments in the feed query', async () => {
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.trace.findMany.mockResolvedValue([]);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    expect(prisma.trace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          likeStats: expect.objectContaining({
            take: expect.any(Number),
            orderBy: { updatedAt: 'desc' },
          }),
          comments: expect.objectContaining({
            take: expect.any(Number),
            orderBy: { createdAt: 'desc' },
          }),
        }),
      }),
    );
  });

  it('narrows the feed to a single author when authorId is a visible friend', async () => {
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'friend-1' },
    ]);
    privacySettings.canViewMoments.mockResolvedValue(true);
    prisma.trace.findMany.mockResolvedValue([]);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', {
      page: 1,
      limit: 20,
      authorId: 'friend-1',
    });

    expect(prisma.trace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ fromID: 'friend-1' }),
      }),
    );
  });

  it('returns empty without querying when authorId is not visible to the viewer', async () => {
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.trace.findMany.mockResolvedValue([]);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const result = await service.getFeed('viewer-1', {
      page: 1,
      limit: 20,
      authorId: 'stranger-1',
    });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(prisma.trace.findMany).not.toHaveBeenCalled();
  });

  it('hides a chat-only friend from the album feed even when asked by authorId', async () => {
    // friend-1 (friendID) granted viewer-1 (userID) only CHAT_ONLY via permissionB,
    // so viewer-1 must not see friend-1's moments.
    prisma.friend.findMany.mockResolvedValue([
      {
        userID: 'viewer-1',
        friendID: 'friend-1',
        permissionA: 'FULL',
        permissionB: 'CHAT_ONLY',
      },
    ]);
    privacySettings.canViewMoments.mockResolvedValue(true);
    prisma.trace.findMany.mockResolvedValue([]);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const result = await service.getFeed('viewer-1', {
      page: 1,
      limit: 20,
      authorId: 'friend-1',
    });

    expect(result.items).toEqual([]);
    expect(prisma.trace.findMany).not.toHaveBeenCalled();
  });

  it('excludes a friend who hides their moments from the feed scope (batched privacy check)', async () => {
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'friend-open' },
      { userID: 'viewer-1', friendID: 'friend-private' },
    ]);
    // friend-private has momentsVisibility=PRIVATE; getSettingsMany surfaces it.
    privacySettings.getSettingsMany.mockResolvedValue(
      new Map([['friend-private', { momentsVisibility: 'PRIVATE' }]]),
    );
    prisma.trace.findMany.mockResolvedValue([]);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    const whereArg = prisma.trace.findMany.mock.calls[0][0].where;
    expect(whereArg.fromID.in).toContain('viewer-1');
    expect(whereArg.fromID.in).toContain('friend-open');
    expect(whereArg.fromID.in).not.toContain('friend-private');
  });

  it('keyset mode (cursor): no skip, no count(), fetches limit+1 with the tuple predicate', async () => {
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'friend-1' },
    ]);
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    // limit=2 → return 3 rows so the extra row signals a next page.
    prisma.trace.findMany.mockResolvedValue([
      makeTraceRow('t3', new Date('2026-06-03T00:00:00.000Z')),
      makeTraceRow('t2', new Date('2026-06-02T00:00:00.000Z')),
      makeTraceRow('t1', new Date('2026-06-01T00:00:00.000Z')),
    ]);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const cursor = encodeTraceCursor(
      new Date('2026-06-04T00:00:00.000Z'),
      't4',
    );
    const result = await service.getFeed('viewer-1', { limit: 2, cursor });

    // No count() runs on the keyset path.
    expect(prisma.trace.count).not.toHaveBeenCalled();
    const args = prisma.trace.findMany.mock.calls[0][0];
    expect(args.take).toBe(3); // limit + 1
    expect(args.skip).toBeUndefined();
    // Keyset predicate is ANDed onto the base visibility filter.
    expect(Array.isArray(args.where.AND)).toBe(true);

    // Only `limit` items returned; the dropped extra row drives hasMore/cursor.
    expect(result.items).toHaveLength(2);
    expect(result.total).toBeNull();
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(
      encodeTraceCursor(new Date('2026-06-02T00:00:00.000Z'), 't2'),
    );
  });

  it('keyset last page: fewer than limit+1 rows → hasMore false, nextCursor null', async () => {
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    prisma.trace.findMany.mockResolvedValue([
      makeTraceRow('t1', new Date('2026-06-01T00:00:00.000Z')),
    ]);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const cursor = encodeTraceCursor(
      new Date('2026-06-02T00:00:00.000Z'),
      't2',
    );
    const result = await service.getFeed('viewer-1', { limit: 2, cursor });

    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor before touching the DB', async () => {
    await expect(
      service.getFeed('viewer-1', { cursor: 'not a valid cursor' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.trace.findMany).not.toHaveBeenCalled();
  });

  it('cursor encode/decode round-trips (createdAt + id)', () => {
    const at = new Date('2026-06-08T12:34:56.000Z');
    const decoded = decodeTraceCursor(encodeTraceCursor(at, 'abc-123'));
    expect(decoded.id).toBe('abc-123');
    expect(decoded.createdAt.toISOString()).toBe(at.toISOString());
  });

  it('toggleLike increments likeCount atomically and returns the DB value', async () => {
    const notification = {
      id: 'notification-1',
      type: 'TRACE_LIKE',
    };
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceLikeStat.findUnique.mockResolvedValue(null);
    prisma.traceLikeStat.create.mockResolvedValue({ id: 'like-1' });
    prisma.trace.update.mockResolvedValue({ likeCount: 8 });
    notificationService.createTraceLikeNotification.mockResolvedValue(
      notification,
    );

    const result = await service.toggleLike('viewer-1', 'trace-1');

    expect(result).toEqual({ liked: true, likeCount: 8 });
    expect(prisma.trace.update).toHaveBeenCalledWith({
      where: { id: 'trace-1' },
      data: { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
    expect(
      notificationService.createTraceLikeNotification,
    ).toHaveBeenCalledWith({
      actorId: 'viewer-1',
      traceId: 'trace-1',
      traceOwnerId: 'author-1',
    });
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'author-1',
      notification,
    );
  });

  it('does not fail a successful like when notification delivery fails', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceLikeStat.findUnique.mockResolvedValue(null);
    prisma.traceLikeStat.create.mockResolvedValue({ id: 'like-1' });
    prisma.trace.update.mockResolvedValue({ likeCount: 8 });
    notificationService.createTraceLikeNotification.mockRejectedValue(
      new Error('notification unavailable'),
    );

    await expect(service.toggleLike('viewer-1', 'trace-1')).resolves.toEqual({
      liked: true,
      likeCount: 8,
    });
  });

  it('toggleLike on an existing like unlikes and decrements', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceLikeStat.findUnique.mockResolvedValue({
      id: 'like-1',
      deleted: false,
    });
    prisma.traceLikeStat.update.mockResolvedValue({ id: 'like-1' });
    prisma.trace.update.mockResolvedValue({ likeCount: 4 });

    const result = await service.toggleLike('viewer-1', 'trace-1');

    expect(result).toEqual({ liked: false, likeCount: 4 });
    expect(prisma.trace.update).toHaveBeenCalledWith({
      where: { id: 'trace-1' },
      data: { likeCount: { increment: -1 } },
      select: { likeCount: true },
    });
    expect(
      notificationService.createTraceLikeNotification,
    ).not.toHaveBeenCalled();
    expect(realtimeService.broadcastNotificationCreated).not.toHaveBeenCalled();
  });
});
