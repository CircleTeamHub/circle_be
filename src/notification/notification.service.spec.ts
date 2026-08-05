import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationType, Prisma } from 'src/generated/prisma';
import { DISCOVER_NOTIFICATION_TYPES } from './notification.constants';
import { NotificationPushService } from './notification-push.service';
import { AdminAuditService } from 'src/moderation/admin-audit.service';

describe('NotificationService', () => {
  let service: NotificationService;

  const prisma = {
    user: {
      findMany: jest.fn(),
    },
    notification: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      createManyAndReturn: jest.fn(),
    },
    devicePushToken: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    notificationPushOutbox: {
      upsert: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
    },
    systemAnnouncement: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    $queryRaw: jest.fn(),
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
  const auditService = {
    record: jest.fn(),
    recordStrict: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const nested of Object.values(prisma.notification) as jest.Mock[]) {
      nested.mockReset();
    }
    for (const nested of Object.values(prisma.user) as jest.Mock[]) {
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
    for (const nested of Object.values(
      prisma.systemAnnouncement,
    ) as jest.Mock[]) {
      nested.mockReset();
    }
    pushService.sendNotification.mockReset();
    auditService.record.mockReset();
    auditService.recordStrict.mockReset();
    prisma.$queryRaw.mockReset();
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.systemAnnouncement.updateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationPushService, useValue: pushService },
        { provide: AdminAuditService, useValue: auditService },
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

  it('publishes an admin system announcement to active users with push outbox rows and unread broadcasts', async () => {
    prisma.systemAnnouncement.upsert.mockResolvedValue({
      id: 'announcement-1',
      requestFingerprint: 'admin-1:Maintenance starts at 22:00.',
      createdAt: new Date('2026-07-29T12:00:00.000Z'),
      auditRecordedAt: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { id: 'user-1' },
      { id: 'user-2' },
    ]);
    prisma.notification.createManyAndReturn.mockResolvedValue([
      { id: 'notification-1', toUserID: 'user-1' },
      { id: 'notification-2', toUserID: 'user-2' },
    ]);
    prisma.notification.count.mockResolvedValue(2);

    await expect(
      (service.publishSystemAnnouncement as any)(
        'admin-1',
        {
          content: 'Maintenance starts at 22:00.',
        },
        'announcement-request-1',
        {
          ip: '127.0.0.1',
          userAgent: 'jest',
        },
      ),
    ).resolves.toEqual({ createdCount: 2 });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        status: 'ACTIVE',
        createdAt: { lte: new Date('2026-07-29T12:00:00.000Z') },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 500,
    });
    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          toUserID: 'user-1',
          fromUserID: 'admin-1',
          type: NotificationType.SYSTEM,
          content: 'Maintenance starts at 22:00.',
          systemAnnouncementID: 'announcement-1',
        },
        {
          toUserID: 'user-2',
          fromUserID: 'admin-1',
          type: NotificationType.SYSTEM,
          content: 'Maintenance starts at 22:00.',
          systemAnnouncementID: 'announcement-1',
        },
      ],
      skipDuplicates: true,
      select: { id: true, toUserID: true },
    });
    expect(prisma.notificationPushOutbox.createMany).toHaveBeenCalledWith({
      data: [
        { notificationID: 'notification-1' },
        { notificationID: 'notification-2' },
      ],
    });
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).toHaveBeenCalledWith('user-1');
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).toHaveBeenCalledWith('user-2');
    expect(auditService.recordStrict).toHaveBeenCalledWith(prisma, {
      actorID: 'admin-1',
      action: 'system_announcement_publish',
      entityType: 'SystemAnnouncement',
      entityID: 'announcement-1',
      after: {
        content: 'Maintenance starts at 22:00.',
        createdCount: 2,
      },
      ip: '127.0.0.1',
      userAgent: 'jest',
    });
  });

  it('resumes a partially committed announcement without duplicating prior recipients', async () => {
    const recipients = Array.from({ length: 501 }, (_, index) => ({
      id: `user-${String(index + 1).padStart(3, '0')}`,
    }));
    prisma.systemAnnouncement.upsert.mockResolvedValue({
      id: 'announcement-1',
      requestFingerprint: 'admin-1:Maintenance',
      createdAt: new Date('2026-07-29T12:00:00.000Z'),
      auditRecordedAt: null,
    });
    prisma.user.findMany
      .mockResolvedValueOnce(recipients.slice(0, 500))
      .mockResolvedValueOnce(recipients.slice(500))
      .mockResolvedValueOnce(recipients.slice(0, 500))
      .mockResolvedValueOnce(recipients.slice(500));
    prisma.notification.createManyAndReturn
      .mockResolvedValueOnce(
        recipients.slice(0, 500).map(({ id }, index) => ({
          id: `notification-${index + 1}`,
          toUserID: id,
        })),
      )
      .mockRejectedValueOnce(new Error('second batch failed'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'notification-501', toUserID: 'user-501' },
      ]);
    prisma.notification.count.mockResolvedValue(501);

    await expect(
      (service.publishSystemAnnouncement as any)(
        'admin-1',
        { content: 'Maintenance' },
        'announcement-request-1',
      ),
    ).rejects.toThrow('second batch failed');

    await expect(
      (service.publishSystemAnnouncement as any)(
        'admin-1',
        { content: 'Maintenance' },
        'announcement-request-1',
      ),
    ).resolves.toEqual({ createdCount: 501 });

    const batchCalls = prisma.notification.createManyAndReturn.mock.calls;
    expect(batchCalls).toHaveLength(4);
    expect(batchCalls[0]?.[0]).toMatchObject({
      skipDuplicates: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          toUserID: 'user-001',
          systemAnnouncementID: 'announcement-1',
        }),
      ]),
    });
    expect(batchCalls[2]?.[0]).toMatchObject({
      skipDuplicates: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          toUserID: 'user-001',
          systemAnnouncementID: 'announcement-1',
        }),
      ]),
    });
    expect(prisma.user.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: 'ACTIVE',
        createdAt: { lte: new Date('2026-07-29T12:00:00.000Z') },
        id: { gt: 'user-500' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 500,
    });
    expect(prisma.user.findMany).toHaveBeenNthCalledWith(4, {
      where: {
        status: 'ACTIVE',
        createdAt: { lte: new Date('2026-07-29T12:00:00.000Z') },
        id: { gt: 'user-500' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 500,
    });
    expect(prisma.systemAnnouncement.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { idempotencyKey: 'announcement-request-1' },
      }),
    );
  });

  it('does not recreate a completed announcement after notification retention cleanup', async () => {
    prisma.systemAnnouncement.upsert.mockResolvedValue({
      id: 'announcement-1',
      requestFingerprint: 'admin-1:Maintenance',
      createdAt: new Date('2026-04-01T12:00:00.000Z'),
      auditRecordedAt: new Date('2026-04-01T12:01:00.000Z'),
      fanoutCompletedAt: new Date('2026-04-01T12:00:30.000Z'),
      recipientCount: 275,
    });

    await expect(
      service.publishSystemAnnouncement(
        'admin-1',
        { content: 'Maintenance' },
        'announcement-request-1',
      ),
    ).resolves.toEqual({ createdCount: 275 });

    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.notification.count).not.toHaveBeenCalled();
  });

  it('does not report a committed announcement as failed when secondary audit logging is unavailable', async () => {
    prisma.systemAnnouncement.upsert.mockResolvedValue({
      id: 'announcement-1',
      requestFingerprint: 'admin-1:Maintenance',
      createdAt: new Date('2026-07-29T12:00:00.000Z'),
      auditRecordedAt: null,
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'user-1' }]);
    prisma.notification.createManyAndReturn.mockResolvedValue([
      { id: 'notification-1', toUserID: 'user-1' },
    ]);
    prisma.notification.count.mockResolvedValue(1);
    auditService.recordStrict.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      (service.publishSystemAnnouncement as any)(
        'admin-1',
        { content: 'Maintenance' },
        'announcement-request-1',
      ),
    ).resolves.toEqual({ createdCount: 1 });
  });

  it('retries a failed durable announcement audit even when no recipients are new', async () => {
    prisma.systemAnnouncement.upsert.mockResolvedValue({
      id: 'announcement-1',
      requestFingerprint: 'admin-1:Maintenance',
      createdAt: new Date('2026-07-29T12:00:00.000Z'),
      auditRecordedAt: null,
    });
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'user-1' }])
      .mockResolvedValueOnce([]);
    prisma.notification.createManyAndReturn.mockResolvedValueOnce([
      { id: 'notification-1', toUserID: 'user-1' },
    ]);
    prisma.notification.count.mockResolvedValue(1);
    auditService.recordStrict
      .mockRejectedValueOnce(new Error('audit unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service.publishSystemAnnouncement(
        'admin-1',
        { content: 'Maintenance' },
        'announcement-request-1',
      ),
    ).resolves.toEqual({ createdCount: 1 });
    await expect(
      service.publishSystemAnnouncement(
        'admin-1',
        { content: 'Maintenance' },
        'announcement-request-1',
      ),
    ).resolves.toEqual({ createdCount: 1 });

    expect(auditService.recordStrict).toHaveBeenCalledTimes(2);
  });

  it('freezes announcement recipients at the first publish timestamp', async () => {
    const createdAt = new Date('2026-07-29T12:00:00.000Z');
    prisma.systemAnnouncement.upsert.mockResolvedValue({
      id: 'announcement-1',
      requestFingerprint: 'admin-1:Maintenance',
      createdAt,
      auditRecordedAt: null,
    });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    await service.publishSystemAnnouncement(
      'admin-1',
      { content: 'Maintenance' },
      'announcement-request-1',
    );

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'ACTIVE',
          createdAt: { lte: createdAt },
        },
      }),
    );
  });

  it('allows only one announcement fan-out at a time', async () => {
    let releaseUpsert!: () => void;
    const pendingUpsert = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    prisma.systemAnnouncement.upsert.mockImplementationOnce(async () => {
      await pendingUpsert;
      return {
        id: 'announcement-1',
        requestFingerprint: 'admin-1:First',
        createdAt: new Date('2026-07-29T12:00:00.000Z'),
        auditRecordedAt: null,
      };
    });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    const first = service.publishSystemAnnouncement(
      'admin-1',
      { content: 'First' },
      'announcement-request-1',
    );
    await expect(
      service.publishSystemAnnouncement(
        'admin-2',
        { content: 'Second' },
        'announcement-request-2',
      ),
    ).rejects.toMatchObject({ status: 429 });
    releaseUpsert();
    await expect(first).resolves.toEqual({ createdCount: 0 });
  });

  it('rejects an announcement when another replica holds the database lock', async () => {
    const otherReplica = new NotificationService(
      prisma as never,
      realtimeService as never,
      pushService as never,
      auditService as never,
    );
    prisma.$queryRaw.mockResolvedValueOnce([{ acquired: false }]);

    await expect(
      otherReplica.publishSystemAnnouncement(
        'admin-2',
        { content: 'Second' },
        'announcement-request-2',
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(prisma.systemAnnouncement.upsert).not.toHaveBeenCalled();
  });

  it('rejects reusing an announcement idempotency key with different content', async () => {
    prisma.systemAnnouncement.upsert.mockResolvedValue({
      id: 'announcement-1',
      requestFingerprint: 'admin-1:Original content',
      createdAt: new Date('2026-07-29T12:00:00.000Z'),
      auditRecordedAt: null,
    });

    await expect(
      (service.publishSystemAnnouncement as any)(
        'admin-1',
        { content: 'Different content' },
        'announcement-request-1',
      ),
    ).rejects.toThrow(
      'Idempotency-Key has already been used for another announcement',
    );
    expect(prisma.user.findMany).not.toHaveBeenCalled();
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

    it('refuses to rebind a token owned by another account', async () => {
      // 拿到别人的设备令牌就能改挂到自己名下 = 受害者收不到自己的推送，反而在锁屏上
      // 收到攻击者的通知；顺带还把设备侧的撤销密钥抹掉。
      prisma.devicePushToken.findUnique.mockResolvedValue({
        userID: 'victim',
        revocationSecretHash: 'hash-of-victim-secret',
      });

      await expect(
        service.registerPushToken('attacker', {
          token: 'ExponentPushToken[abc]',
          platform: 'ios',
          provider: 'expo',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.devicePushToken.upsert).not.toHaveBeenCalled();
    });

    it('allows rebinding when the caller proves the revocation secret', async () => {
      // 同一台设备换账号登录是正常场景：客户端手里本来就有这个 secret。
      const secret = 'device-secret';
      const hash = createHash('sha256').update(secret).digest('hex');
      prisma.devicePushToken.findUnique.mockResolvedValue({
        userID: 'previous-owner',
        revocationSecretHash: hash,
      });
      prisma.devicePushToken.upsert.mockResolvedValue({ id: 'token-row-1' });

      await service.registerPushToken('new-owner', {
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
        provider: 'expo',
        revocationSecret: secret,
      });

      expect(prisma.devicePushToken.upsert).toHaveBeenCalled();
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

    it('creates published-post notifications and push outbox rows in the supplied transaction', async () => {
      const baseRow = {
        type: NotificationType.CIRCLE_POST_PUBLISHED,
        content: '',
        read: false,
        createdAt: new Date('2026-06-29T12:00:00Z'),
        fromUser: { id: 'author-1', nickname: 'Host', avatarUrl: null },
        fromTrace: null,
        fromReply: null,
        fromCircle: null,
        fromCirclePost: { id: 'post-1', content: 'hi', images: [] },
        fromInvitation: null,
        fromFriendRequest: null,
      };
      const tx = {
        notification: {
          createManyAndReturn: jest.fn().mockResolvedValue([
            { id: 'n2', toUserID: 'member-2' },
            { id: 'n3', toUserID: 'member-3' },
          ]),
          findMany: jest.fn().mockResolvedValue([
            { ...baseRow, id: 'n2', toUserID: 'member-2' },
            { ...baseRow, id: 'n3', toUserID: 'member-3' },
          ]),
        },
        notificationPushOutbox: {
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      } as unknown as Prisma.TransactionClient;

      const result = await service.createCirclePostPublishedNotifications(tx, {
        postId: 'post-1',
        fromUserId: 'author-1',
        recipientIds: ['member-2', 'member-3', 'author-1', 'member-2'],
      });

      expect(tx.notification.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          {
            toUserID: 'member-2',
            fromUserID: 'author-1',
            type: NotificationType.CIRCLE_POST_PUBLISHED,
            fromCirclePostID: 'post-1',
            content: '',
          },
          {
            toUserID: 'member-3',
            fromUserID: 'author-1',
            type: NotificationType.CIRCLE_POST_PUBLISHED,
            fromCirclePostID: 'post-1',
            content: '',
          },
        ],
        select: { id: true, toUserID: true },
      });
      expect(tx.notificationPushOutbox.createMany).toHaveBeenCalledWith({
        data: [{ notificationID: 'n2' }, { notificationID: 'n3' }],
      });
      expect(tx.notification.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['n2', 'n3'] } },
        include: expect.any(Object),
      });
      expect(pushService.sendNotification).not.toHaveBeenCalled();
      expect(result.map(({ toUserId }) => toUserId)).toEqual([
        'member-2',
        'member-3',
      ]);
    });

    it('propagates push outbox creation failure to the caller transaction', async () => {
      const outboxError = new Error('outbox unavailable');
      const tx = {
        notification: {
          createManyAndReturn: jest
            .fn()
            .mockResolvedValue([{ id: 'n2', toUserID: 'member-2' }]),
          findMany: jest.fn(),
        },
        notificationPushOutbox: {
          createMany: jest.fn().mockRejectedValue(outboxError),
        },
      } as unknown as Prisma.TransactionClient;

      await expect(
        service.createCirclePostPublishedNotifications(tx, {
          postId: 'post-1',
          fromUserId: 'author-1',
          recipientIds: ['member-2'],
        }),
      ).rejects.toBe(outboxError);
      expect(tx.notification.findMany).not.toHaveBeenCalled();
      expect(pushService.sendNotification).not.toHaveBeenCalled();
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
