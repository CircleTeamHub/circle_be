import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationType } from 'src/generated/prisma';
import { DISCOVER_NOTIFICATION_TYPES } from './notification.constants';
import { NotificationPushService } from './notification-push.service';

describe('NotificationService', () => {
  let service: NotificationService;

  const prisma = {
    notification: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    devicePushToken: {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    notificationPushOutbox: {
      upsert: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(async (operation: any) =>
      typeof operation === 'function'
        ? operation(prisma)
        : Promise.all(operation),
    ),
  };

  const realtimeService = {
    broadcastInteractionUnread: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
  };
  const pushService = {
    sendNotification: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const nested of Object.values(prisma.notification) as jest.Mock[]) {
      nested.mockReset();
    }
    for (const nested of Object.values(prisma.devicePushToken) as jest.Mock[]) {
      nested.mockReset();
    }
    for (const nested of Object.values(
      prisma.notificationPushOutbox,
    ) as jest.Mock[]) {
      nested.mockReset();
    }
    pushService.sendNotification.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationPushService, useValue: pushService },
      ],
    }).compile();

    service = module.get(NotificationService);
  });

  it('builds discover/profile unread summary from notification domains', async () => {
    prisma.notification.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    await expect(service.getUnreadSummary('user-1')).resolves.toEqual({
      discoverUnread: 2,
      profileUnread: 1,
      totalUnread: 3,
    });
  });

  it('marks profile-domain notifications as read for a user', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 4 });

    await expect(
      service.markProfileNotificationsRead('user-1'),
    ).resolves.toEqual({
      count: 4,
    });

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        toUserID: 'user-1',
        deleted: false,
        read: false,
        type: { in: ['SYSTEM'] },
      },
      data: { read: true },
    });
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).toHaveBeenCalledWith('user-1');
  });

  it('skips broadcasting unread changes when no rows were updated', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.markProfileNotificationsRead('user-1'),
    ).resolves.toEqual({
      count: 0,
    });

    expect(prisma.notification.updateMany).toHaveBeenCalled();
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).not.toHaveBeenCalled();
  });

  describe('push tokens', () => {
    it('upserts the current user device push token', async () => {
      prisma.devicePushToken.upsert.mockResolvedValue({
        id: 'token-row-1',
      });

      await service.registerPushToken('user-1', {
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
        provider: 'expo',
        projectId: 'project-1',
        appVersion: '1.0.0',
      });

      expect(prisma.devicePushToken.upsert).toHaveBeenCalledWith({
        where: { token: 'ExponentPushToken[abc]' },
        create: {
          token: 'ExponentPushToken[abc]',
          userID: 'user-1',
          platform: 'ios',
          provider: 'expo',
          projectId: 'project-1',
          appVersion: '1.0.0',
        },
        update: {
          userID: 'user-1',
          platform: 'ios',
          provider: 'expo',
          projectId: 'project-1',
          appVersion: '1.0.0',
          disabledAt: null,
          revocationSecretHash: null,
        },
      });
    });

    it('deletes only the current user device push token', async () => {
      prisma.devicePushToken.deleteMany.mockResolvedValue({ count: 1 });

      await service.deletePushToken('user-1', 'ExponentPushToken[abc]');

      expect(prisma.devicePushToken.deleteMany).toHaveBeenCalledWith({
        where: {
          userID: 'user-1',
          token: 'ExponentPushToken[abc]',
        },
      });
    });
  });

  describe('notification center', () => {
    it('deduplicates repeated trace-like notifications inside the cooldown window', async () => {
      prisma.notification.findFirst.mockResolvedValue({
        id: 'existing-like',
      });

      const result = await service.createTraceLikeNotification({
        actorId: 'viewer-1',
        traceId: 'trace-1',
        traceOwnerId: 'author-1',
      });

      expect(result).toBeNull();
      expect(prisma.notification.findFirst).toHaveBeenCalledWith({
        where: {
          toUserID: 'author-1',
          fromUserID: 'viewer-1',
          type: NotificationType.TRACE_LIKE,
          deleted: false,
          fromTraceID: 'trace-1',
          createdAt: { gte: expect.any(Date) },
        },
        select: { id: true },
      });
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('getNotifications maps fromUser/fromTrace/fromReply and paginates', async () => {
      prisma.notification.findMany.mockResolvedValue([
        {
          id: 'n1',
          type: 'TRACE_COMMENT',
          content: 'nice',
          read: false,
          createdAt: new Date('2026-06-05T00:00:00Z'),
          fromUser: { id: 'u2', nickname: 'B', avatarUrl: null },
          fromTrace: { id: 't1', content: 'my trace body', images: ['img1'] },
          fromReply: { id: 'r1', content: 'reply body' },
        },
      ]);

      const result = await service.getNotifications('user-1', 1);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            toUserID: 'user-1',
            deleted: false,
            type: {
              in: [...DISCOVER_NOTIFICATION_TYPES],
            },
          },
          skip: 0,
          take: 20,
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result[0]).toEqual({
        id: 'n1',
        type: 'TRACE_COMMENT',
        content: 'nice',
        read: false,
        createdAt: '2026-06-05T00:00:00.000Z',
        fromUser: { id: 'u2', nickname: 'B', avatarUrl: null },
        fromTrace: { id: 't1', excerpt: 'my trace body', firstImage: 'img1' },
        fromReply: { id: 'r1', content: 'reply body' },
        fromCircle: null,
        fromCirclePost: null,
        fromInvitation: null,
        requestId: null,
      });
    });

    it('excludes friend-request events from the bell channel (they live in the 新的朋友 inbox)', () => {
      const bellTypes = DISCOVER_NOTIFICATION_TYPES as readonly string[];
      expect(bellTypes).toContain('FRIEND_REQUEST_RECEIVED');
      expect(bellTypes).toContain('FRIEND_REQUEST_ACCEPTED');
      expect(bellTypes).toContain('FRIEND_REQUEST_REJECTED');
    });

    it('getProfileNotifications returns only profile-domain system rows', async () => {
      prisma.notification.findMany.mockResolvedValue([
        {
          id: 'sys-1',
          type: 'SYSTEM',
          content: '积分已到账 10',
          read: false,
          createdAt: new Date('2026-07-05T00:00:00Z'),
          fromUser: { id: 'user-1', nickname: 'Me', avatarUrl: null },
          fromTrace: null,
          fromReply: null,
          fromCircle: null,
          fromCirclePost: null,
          fromInvitation: null,
        },
      ]);

      const result = await service.getProfileNotifications('user-1', 2);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            toUserID: 'user-1',
            deleted: false,
            type: { in: ['SYSTEM'] },
          },
          skip: 20,
          take: 20,
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'sys-1',
          type: 'SYSTEM',
          content: '积分已到账 10',
        }),
      );
    });

    it('enqueues durable push delivery after creating a friend request notification', async () => {
      prisma.notification.create.mockResolvedValue({
        id: 'friend-n1',
        type: NotificationType.FRIEND_REQUEST_RECEIVED,
        content: 'hello',
        read: false,
        createdAt: new Date('2026-07-05T00:00:00Z'),
        fromUser: { id: 'from-1', nickname: 'Aki', avatarUrl: null },
        fromTrace: null,
        fromReply: null,
        fromCircle: null,
        fromCirclePost: null,
        fromInvitation: null,
      });

      const result = await service.createFriendRequestNotification({
        type: NotificationType.FRIEND_REQUEST_RECEIVED,
        toUserId: 'to-1',
        fromUserId: 'from-1',
        content: 'hello',
      });

      expect(prisma.notificationPushOutbox.create).toHaveBeenCalledWith({
        data: { notificationID: 'friend-n1' },
      });
      expect(result).toEqual(expect.objectContaining({ id: 'friend-n1' }));
    });

    it('fails the notification transaction when durable push enqueue fails', async () => {
      prisma.notification.create.mockResolvedValue({
        id: 'friend-n2',
        type: NotificationType.FRIEND_REQUEST_RECEIVED,
        content: 'hello',
        read: false,
        createdAt: new Date('2026-07-05T00:00:00Z'),
        fromUser: { id: 'from-1', nickname: 'Aki', avatarUrl: null },
        fromTrace: null,
        fromReply: null,
        fromCircle: null,
        fromCirclePost: null,
        fromInvitation: null,
      });
      prisma.notificationPushOutbox.create.mockRejectedValue(
        new Error('outbox unavailable'),
      );

      await expect(
        service.createFriendRequestNotification({
          type: NotificationType.FRIEND_REQUEST_RECEIVED,
          toUserId: 'to-1',
          fromUserId: 'from-1',
          content: 'hello',
        }),
      ).rejects.toThrow('outbox unavailable');
    });

    it('creates circle invitation notifications through the shared notification path', async () => {
      prisma.notification.create.mockResolvedValue({
        id: 'circle-inv-n1',
        type: NotificationType.CIRCLE_VERIFICATION_REQUESTED,
        content: '',
        read: false,
        createdAt: new Date('2026-07-05T00:00:00Z'),
        fromUser: { id: 'from-1', nickname: 'Aki', avatarUrl: null },
        fromTrace: null,
        fromReply: null,
        fromCircle: { id: 'circle-1', name: 'Circle' },
        fromCirclePost: null,
        fromInvitation: { id: 'inv-1', status: 'PENDING' },
      });

      await service.createCircleInvitationNotification({
        toUserID: 'to-1',
        fromUserID: 'from-1',
        type: NotificationType.CIRCLE_VERIFICATION_REQUESTED,
        fromCircleID: 'circle-1',
        fromInvitationID: 'inv-1',
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          toUserID: 'to-1',
          fromUserID: 'from-1',
          type: NotificationType.CIRCLE_VERIFICATION_REQUESTED,
          fromCircleID: 'circle-1',
          fromInvitationID: 'inv-1',
          content: '',
        },
        include: expect.any(Object),
      });
      expect(prisma.notificationPushOutbox.create).toHaveBeenCalled();
    });

    it('markNotificationRead broadcasts interaction unread for discover-domain rows', async () => {
      prisma.notification.findFirst.mockResolvedValue({
        type: 'CIRCLE_VERIFICATION_REQUESTED',
        read: false,
      });
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      await service.markNotificationRead('user-1', 'n1');
      expect(prisma.notification.findFirst).toHaveBeenCalledWith({
        where: { id: 'n1', toUserID: 'user-1', deleted: false },
        select: { type: true, read: true },
      });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', toUserID: 'user-1', read: false, deleted: false },
        data: { read: true },
      });
      expect(realtimeService.broadcastInteractionUnread).toHaveBeenCalledWith(
        'user-1',
      );
      expect(
        realtimeService.broadcastSystemNotificationUnread,
      ).not.toHaveBeenCalled();
    });

    it('markNotificationRead broadcasts system unread for profile-domain rows', async () => {
      prisma.notification.findFirst.mockResolvedValue({
        type: 'SYSTEM',
        read: false,
      });
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      await service.markNotificationRead('user-1', 'n1');
      expect(
        realtimeService.broadcastSystemNotificationUnread,
      ).toHaveBeenCalledWith('user-1');
      expect(realtimeService.broadcastInteractionUnread).not.toHaveBeenCalled();
    });

    it('markNotificationRead skips broadcasting when no row changed', async () => {
      prisma.notification.findFirst.mockResolvedValue({
        type: 'TRACE_COMMENT',
        read: false,
      });
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      await service.markNotificationRead('user-1', 'n1');
      expect(realtimeService.broadcastInteractionUnread).not.toHaveBeenCalled();
      expect(
        realtimeService.broadcastSystemNotificationUnread,
      ).not.toHaveBeenCalled();
    });

    it('markNotificationRead skips broadcasting when the row is missing', async () => {
      jest.clearAllMocks();
      prisma.notification.findFirst.mockResolvedValue(null);
      await service.markNotificationRead('user-1', 'n1');
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
      expect(realtimeService.broadcastInteractionUnread).not.toHaveBeenCalled();
      expect(
        realtimeService.broadcastSystemNotificationUnread,
      ).not.toHaveBeenCalled();
    });

    it('creates auto-ended circle post notifications for the author with post routing data', async () => {
      prisma.notification.create.mockResolvedValue({
        id: 'n-auto',
        type: NotificationType.CIRCLE_POST_AUTO_ENDED,
        content: '',
        read: false,
        createdAt: new Date('2026-06-29T12:00:00Z'),
        fromUser: { id: 'author-1', nickname: 'Host', avatarUrl: null },
        fromTrace: null,
        fromReply: null,
        fromCircle: null,
        fromCirclePost: {
          id: 'post-1',
          content: 'Board game night',
          images: [],
        },
        fromInvitation: null,
      });

      const result = await service.createCirclePostAutoEndedNotification({
        toUserId: 'author-1',
        postId: 'post-1',
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          toUserID: 'author-1',
          fromUserID: 'author-1',
          type: NotificationType.CIRCLE_POST_AUTO_ENDED,
          fromCirclePostID: 'post-1',
          content: '',
        },
        include: expect.any(Object),
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: 'n-auto',
          type: NotificationType.CIRCLE_POST_AUTO_ENDED,
          fromCirclePost: {
            id: 'post-1',
            excerpt: 'Board game night',
            firstImage: null,
          },
        }),
      );
    });

    it('markAllNotificationsRead returns count', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 4 });
      const result = await service.markAllNotificationsRead('user-1');
      expect(result).toEqual({ count: 4 });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: {
          toUserID: 'user-1',
          deleted: false,
          read: false,
          type: {
            in: [...DISCOVER_NOTIFICATION_TYPES],
          },
        },
        data: { read: true },
      });
      expect(realtimeService.broadcastInteractionUnread).toHaveBeenCalledWith(
        'user-1',
      );
    });

    it('deleteNotification soft-deletes and broadcasts interaction unread for unread discover rows', async () => {
      prisma.notification.findFirst.mockResolvedValue({
        type: 'CIRCLE_INVITATION_APPROVED',
        read: false,
      });
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      await service.deleteNotification('user-1', 'n1');
      expect(prisma.notification.findFirst).toHaveBeenCalledWith({
        where: { id: 'n1', toUserID: 'user-1', deleted: false },
        select: { type: true, read: true },
      });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', toUserID: 'user-1', deleted: false },
        data: { deleted: true },
      });
      expect(realtimeService.broadcastInteractionUnread).toHaveBeenCalledWith(
        'user-1',
      );
      expect(
        realtimeService.broadcastSystemNotificationUnread,
      ).not.toHaveBeenCalled();
    });

    it('deleteNotification does not broadcast for already-read rows', async () => {
      prisma.notification.findFirst.mockResolvedValue({
        type: 'TRACE_COMMENT',
        read: true,
      });
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      await service.deleteNotification('user-1', 'n1');
      expect(realtimeService.broadcastInteractionUnread).not.toHaveBeenCalled();
      expect(
        realtimeService.broadcastSystemNotificationUnread,
      ).not.toHaveBeenCalled();
    });
  });
});
