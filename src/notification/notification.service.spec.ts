import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { RealtimeService } from 'src/realtime/realtime.service';

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
  };

  const realtimeService = {
    broadcastInteractionUnread: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
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

  describe('notification center', () => {
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
              in: [
                'TRACE_COMMENT',
                'COMMENT_REPLY',
                'CIRCLE_VERIFICATION_REQUESTED',
                'CIRCLE_INVITATION_APPROVED',
                'CIRCLE_INVITATION_REJECTED',
                'CIRCLE_ADMIN_OVERRIDE_APPROVED',
              ],
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
        fromInvitation: null,
      });
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
      expect(
        realtimeService.broadcastInteractionUnread,
      ).not.toHaveBeenCalled();
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
            in: [
              'TRACE_COMMENT',
              'COMMENT_REPLY',
              'CIRCLE_VERIFICATION_REQUESTED',
              'CIRCLE_INVITATION_APPROVED',
              'CIRCLE_INVITATION_REJECTED',
              'CIRCLE_ADMIN_OVERRIDE_APPROVED',
            ],
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
