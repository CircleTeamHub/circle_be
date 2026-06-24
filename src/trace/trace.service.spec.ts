import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { TraceService } from './trace.service';

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
          squadRequest: null,
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
