import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationType, Prisma } from 'src/generated/prisma';
import {
  CIRCLE_NOTIFICATION_TYPES,
  DISCOVER_NOTIFICATION_TYPES,
  MOMENT_NOTIFICATION_TYPES,
} from './notification.constants';
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  NOTIFICATION_REALTIME_BASE_SELECT,
  type NotificationRealtimeBaseRow,
} from './notification.dto';
import { NotificationPushService } from './notification-push.service';
import { AdminAuditService } from 'src/moderation/admin-audit.service';

/** 实时 DTO 回填用的 Notification 本表行（关系另由 loader 按外键查）。 */
function baseRow(
  overrides: Partial<NotificationRealtimeBaseRow> &
    Pick<NotificationRealtimeBaseRow, 'id' | 'type'>,
): NotificationRealtimeBaseRow {
  return {
    content: '',
    read: false,
    createdAt: new Date('2026-07-05T00:00:00Z'),
    toUserID: 'user-1',
    fromUserID: 'user-1',
    fromTraceID: null,
    fromReplyID: null,
    fromCircleID: null,
    fromCirclePostID: null,
    fromInvitationID: null,
    fromGroupAdmissionID: null,
    fromFriendRequestID: null,
    systemAnnouncementID: null,
    ...overrides,
  };
}

describe('NotificationService', () => {
  let service: NotificationService;

  const prisma = {
    $executeRaw: jest.fn(),
    refreshToken: { findUnique: jest.fn(), findFirst: jest.fn() },
    trustedDevice: { findUnique: jest.fn() },
    user: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
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
      updateMany: jest.fn(),
      create: jest.fn(),
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
      findMany: jest.fn(),
    },
    // 实时 DTO 的关系表：loader 只在外键非空时才查。
    trace: { findMany: jest.fn() },
    traceComment: { findMany: jest.fn() },
    circle: { findMany: jest.fn() },
    circlePost: { findMany: jest.fn() },
    circleInvitation: { findMany: jest.fn() },
    groupAdmission: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
    // inTransaction 让用例能断言「关系是在事务提交之后才读的」。
    inTransaction: false,
    $transaction: jest.fn(async (operation: any) => {
      if (typeof operation !== 'function') return Promise.all(operation);
      prisma.inTransaction = true;
      try {
        return await operation(prisma);
      } finally {
        prisma.inTransaction = false;
      }
    }),
  };
  const RELATION_TABLES = [
    prisma.trace,
    prisma.traceComment,
    prisma.circle,
    prisma.circlePost,
    prisma.circleInvitation,
    prisma.groupAdmission,
  ];

  const realtimeService = {
    broadcastInteractionUnread: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
    broadcastSystemNotificationUnreadToRecipients: jest.fn(),
  };
  const pushService = {
    sendNotification: jest.fn(),
    isJPushConfigured: jest.fn(),
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
    for (const table of RELATION_TABLES) {
      table.findMany.mockReset();
      table.findMany.mockResolvedValue([]);
    }
    prisma.user.findMany.mockResolvedValue([]);
    prisma.systemAnnouncement.findMany.mockResolvedValue([]);
    prisma.inTransaction = false;
    pushService.sendNotification.mockReset();
    pushService.isJPushConfigured.mockReset();
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

  it('builds discover/profile unread summary from one grouped unread query', async () => {
    // 一条 GROUP BY type 取回各类型未读数，域的求和在 JS 里做。
    prisma.$queryRaw.mockResolvedValueOnce([
      { type: 'TRACE_LIKE', count: 1 },
      { type: 'CIRCLE_POST_PUBLISHED', count: 1 },
      { type: 'SYSTEM', count: 1 },
      // 报名通知不属于任何铃铛域，哪个数都不计。
      { type: 'CIRCLE_POST_SIGNUP_CREATED', count: 5 },
    ]);

    await expect(service.getUnreadSummary('user-1')).resolves.toEqual({
      discoverUnread: 2,
      momentsUnread: 1,
      circleUnread: 1,
      profileUnread: 1,
      totalUnread: 3,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const query = prisma.$queryRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(query.sql).toContain('GROUP BY n."type"');
    expect(query.values).toEqual(['user-1']);
    expect(prisma.notification.count).not.toHaveBeenCalled();
  });

  it('keeps the bell domains disjoint', () => {
    const momentTypes = [...MOMENT_NOTIFICATION_TYPES] as string[];
    const circleTypes = [...CIRCLE_NOTIFICATION_TYPES] as string[];
    // 朋友圈铃铛不得收圈子事件，圈子铃铛不得收朋友圈事件。
    expect(momentTypes.filter((type) => circleTypes.includes(type))).toEqual(
      [],
    );
    expect(momentTypes.some((type) => type.startsWith('CIRCLE_'))).toBe(false);
    expect(circleTypes.every((type) => type.startsWith('CIRCLE_'))).toBe(true);
    expect(circleTypes).not.toContain('CIRCLE_POST_SIGNUP_CREATED');
  });

  it('getNotifications scopes rows to one bell domain when asked', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.getNotifications('user-1', 1, 'moments');
    expect(prisma.$queryRaw.mock.calls[0][0].values).toEqual([
      'user-1',
      ...MOMENT_NOTIFICATION_TYPES,
      20,
    ]);

    await service.getNotifications('user-1', 1, 'circle');
    expect(prisma.$queryRaw.mock.calls[1][0].values).toEqual([
      'user-1',
      ...CIRCLE_NOTIFICATION_TYPES,
      20,
    ]);
    // 空页不回填。
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it('markAllNotificationsRead only clears the requested domain', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 2 });

    await service.markAllNotificationsRead('user-1', 'moments');

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        toUserID: 'user-1',
        deleted: false,
        read: false,
        type: { in: [...MOMENT_NOTIFICATION_TYPES] },
      },
      data: { read: true },
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
      requestFingerprint: JSON.stringify([
        'admin-1',
        'Maintenance notice',
        'Maintenance starts at 22:00.',
      ]),
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
          title: 'Maintenance notice',
          content: 'Maintenance starts at 22:00.',
        },
        'announcement-request-1',
        {
          ip: '127.0.0.1',
          userAgent: 'jest',
        },
      ),
    ).resolves.toEqual({ createdCount: 2 });

    expect(prisma.systemAnnouncement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ title: 'Maintenance notice' }),
      }),
    );
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
          fromUserID: 'user-1',
          type: NotificationType.SYSTEM,
          content: 'Maintenance starts at 22:00.',
          systemAnnouncementID: 'announcement-1',
        },
        {
          toUserID: 'user-2',
          fromUserID: 'user-2',
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
    // 每批收件人一次批量广播(一条 GROUP BY 计数),不再逐人一条 count。
    expect(
      realtimeService.broadcastSystemNotificationUnreadToRecipients,
    ).toHaveBeenCalledTimes(1);
    expect(
      realtimeService.broadcastSystemNotificationUnreadToRecipients,
    ).toHaveBeenCalledWith(['user-1', 'user-2']);
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).not.toHaveBeenCalled();
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

  // 公告行的 fromUser 会随 GET /notification/profile/list 原样回给每个收件人,
  // 客户端从不渲染它;挂管理员等于把「谁发的公告」泄露给全站。沿用
  // createSystemNotification 的自发自收约定,操作者只记在 SystemAnnouncement 上。
  it('fans out announcement rows with the recipient as sender, never the publishing admin', async () => {
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

    await (service.publishSystemAnnouncement as any)(
      'admin-1',
      { content: 'Maintenance starts at 22:00.' },
      'announcement-request-1',
    );

    const rows = prisma.notification.createManyAndReturn.mock.calls.flatMap(
      ([args]) => args.data as Array<{ toUserID: string; fromUserID: string }>,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.fromUserID).toBe(row.toUserID);
      expect(row.fromUserID).not.toBe('admin-1');
    }
    expect(prisma.systemAnnouncement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ operatorID: 'admin-1' }),
      }),
    );
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

  it('does not fail a committed announcement when the unread broadcast fails', async () => {
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
    realtimeService.broadcastSystemNotificationUnreadToRecipients.mockRejectedValueOnce(
      new Error('redis down'),
    );

    await expect(
      service.publishSystemAnnouncement(
        'admin-1',
        { content: 'Maintenance' },
        'announcement-request-1',
      ),
    ).resolves.toEqual({ createdCount: 1 });
    expect(prisma.systemAnnouncement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recipientCount: 1 }),
      }),
    );
  });

  describe('push tokens', () => {
    it('rejects JPush registration when server credentials are absent', async () => {
      pushService.isJPushConfigured.mockReturnValue(false);

      await expect(
        service.registerPushToken('user-1', {
          token: 'registration-id',
          platform: 'android',
          provider: 'jpush',
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.devicePushToken.create).not.toHaveBeenCalled();
    });

    it('registers a brand-new device push token', async () => {
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.devicePushToken.create.mockResolvedValue({ id: 'token-row-1' });

      await service.registerPushToken('user-1', {
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
        provider: 'expo',
        projectId: 'project-1',
        appVersion: '1.0.0',
      });

      // 归属判定必须与写入同一条语句:先读后写会让两个账号同时登记一个
      // 此前没见过的令牌时都读到「无主」,后写的那个不出示 secret 就把它抢走。
      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith({
        where: {
          token: 'ExponentPushToken[abc]',
          OR: [
            { userID: 'user-1', OR: [{ deviceKey: null }] },
            // 无 secret 登记时,谓词只多出 null 这一支(没有 hash 可比)。
            { revocationSecretHash: null },
          ],
        },
        data: expect.objectContaining({ userID: 'user-1' }),
      });
      expect(prisma.devicePushToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          token: 'ExponentPushToken[abc]',
          userID: 'user-1',
        }),
      });
    });

    it('stores the call push version and APNs environment of a VoIP token', async () => {
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.devicePushToken.create.mockResolvedValue({ id: 'token-row-1' });

      await service.registerPushToken('user-1', {
        token: 'a1'.repeat(32),
        platform: 'ios',
        provider: 'apns_voip',
        callPushVersion: 1,
        apnsEnvironment: 'development',
      });

      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            provider: 'apns_voip',
            callPushVersion: 1,
            apnsEnvironment: 'development',
          }),
        }),
      );
      expect(prisma.devicePushToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider: 'apns_voip',
          callPushVersion: 1,
          apnsEnvironment: 'development',
        }),
      });
    });

    it('defaults VoIP tokens to production and clears call fields for old clients', async () => {
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });

      await service.registerPushToken('user-1', {
        token: 'b2'.repeat(32),
        platform: 'ios',
        provider: 'apns_voip',
        callPushVersion: 1,
      });
      // 降级回旧版本的 App 重新登记时不带 callPushVersion：要清回 null，
      // 否则后端会继续给一台不会响铃的设备发来电推送。
      await service.registerPushToken('user-1', {
        token: '190e35e4f7b94e5fa2c6',
        platform: 'android',
        provider: 'jpush',
      });

      expect(
        prisma.devicePushToken.updateMany.mock.calls[0][0].data,
      ).toMatchObject({
        callPushVersion: 1,
        apnsEnvironment: 'production',
      });
      expect(
        prisma.devicePushToken.updateMany.mock.calls[1][0].data,
      ).toMatchObject({
        callPushVersion: null,
        apnsEnvironment: null,
      });
    });

    it('refuses VoIP tokens that do not come from iOS', async () => {
      await expect(
        service.registerPushToken('user-1', {
          token: 'a1'.repeat(32),
          platform: 'android',
          provider: 'apns_voip',
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
    });

    it('re-registering an own token never falls through to create', async () => {
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });

      await service.registerPushToken('user-1', {
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
        provider: 'expo',
      });

      expect(prisma.devicePushToken.create).not.toHaveBeenCalled();
    });

    it('loses the race safely: a concurrent claim surfaces as Forbidden', async () => {
      // 两个账号都先跑完条件更新(都没命中),然后才有人写。
      // 后写的那个撞唯一约束 —— 必须变成拒绝,而不是悄悄换绑。
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.devicePushToken.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );

      await expect(
        service.registerPushToken('loser', {
          token: 'ExponentPushToken[abc]',
          platform: 'ios',
          provider: 'expo',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses to rebind a token owned by another account', async () => {
      // 拿到别人的设备令牌就能改挂到自己名下 = 受害者收不到自己的推送，反而在锁屏上
      // 收到攻击者的通知；顺带还把设备侧的撤销密钥抹掉。
      // 条件更新的归属谓词不命中(不是本人、也没给出正确 secret),
      // 随后的 create 撞唯一约束 → 拒绝。
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.devicePushToken.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );

      await expect(
        service.registerPushToken('attacker', {
          token: 'ExponentPushToken[abc]',
          platform: 'ios',
          provider: 'expo',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.devicePushToken.upsert).not.toHaveBeenCalled();
    });

    // revocationSecret 是可选字段:存量行、以及任何没带 secret 登记过的客户端,
    // 存的都是 null。谓词若不放行 null,同一台设备换账号登录就永远命中不了 →
    // create 撞唯一约束 → 403,而且是永久的(直到推送服务商轮换令牌),新账号
    // 一条推送都收不到。这是把「安全加固」变成了「功能永久损坏」。
    it('still lets a device switch accounts when the stored row has no secret', async () => {
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });

      await service.registerPushToken('new-owner', {
        token: 'ExponentPushToken[legacy]',
        platform: 'ios',
        provider: 'expo',
      });

      const [[args]] = prisma.devicePushToken.updateMany.mock.calls as [
        [{ where: { OR: Array<Record<string, unknown>> } }],
      ];
      expect(args.where.OR).toContainEqual({ revocationSecretHash: null });
      expect(prisma.devicePushToken.create).not.toHaveBeenCalled();
    });

    // 认领一行 null-secret 时若带了 secret,应顺手把它升级成受保护 ——
    // 存量靠这个随客户端升级自然收敛,而不是永远敞着。
    it('upgrades a null-secret row to protected when the claimer supplies one', async () => {
      const secret = 'fresh-secret';
      const hash = createHash('sha256').update(secret).digest('hex');
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });

      await service.registerPushToken('new-owner', {
        token: 'ExponentPushToken[legacy]',
        platform: 'ios',
        provider: 'expo',
        revocationSecret: secret,
      });

      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revocationSecretHash: hash }),
        }),
      );
    });

    // 反过来:不带 secret 的重新登记绝不能把已有的哈希抹成 null —— 那等于
    // 自己把上面那道闸拆了,这行从此谁知道令牌谁就能抢走。
    it('never clears an existing secret when re-registering without one', async () => {
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });

      await service.registerPushToken('user-1', {
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
        provider: 'expo',
      });

      const [[args]] = prisma.devicePushToken.updateMany.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(args.data).not.toHaveProperty('revocationSecretHash');
    });

    it('allows rebinding when the caller proves the revocation secret', async () => {
      // 同一台设备换账号登录是正常场景：客户端手里本来就有这个 secret。
      const secret = 'device-secret';
      const hash = createHash('sha256').update(secret).digest('hex');
      // 归属谓词把 secret 哈希也算进去,所以条件更新直接命中原属他人的那一行。
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });

      await service.registerPushToken('new-owner', {
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
        provider: 'expo',
        revocationSecret: secret,
      });

      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith({
        where: {
          token: 'ExponentPushToken[abc]',
          OR: [
            { userID: 'new-owner', OR: [{ deviceKey: null }] },
            { revocationSecretHash: hash },
            // 迁移通道:存量 null-secret 行必须仍可认领,否则换账号永久 403。
            { revocationSecretHash: null },
          ],
        },
        data: expect.objectContaining({ userID: 'new-owner' }),
      });
      expect(prisma.devicePushToken.create).not.toHaveBeenCalled();
    });

    it('binds registration to the server session rather than client device input', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        userId: 'user-1',
        audience: 'APP',
        deviceKey: 'server-key',
        revokedAt: null,
      });
      prisma.trustedDevice.findUnique.mockResolvedValue({ revokedAt: null });
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.registerPushToken(
          'user-1',
          {
            token: 'ExponentPushToken[abc]',
            provider: 'expo',
            platform: 'ios',
          },
          'session',
        ),
      ).resolves.toEqual({ deviceBound: true });
      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deviceKey: 'server-key' }),
        }),
      );
    });
    it.each(['revoked', 'foreign', 'admin', 'missing', 'untrusted', 'expired'])(
      'rejects an ineligible registration session: %s',
      async (kind) => {
        prisma.refreshToken.findUnique.mockResolvedValue(
          kind === 'missing'
            ? null
            : {
                userId: kind === 'foreign' ? 'other' : 'user-1',
                audience: kind === 'admin' ? 'ADMIN' : 'APP',
                deviceKey: 'key',
                expiredAt: new Date(
                  Date.now() + (kind === 'expired' ? -60000 : 60000),
                ),
                revokedAt: kind === 'revoked' ? new Date() : null,
              },
        );
        prisma.trustedDevice.findUnique.mockResolvedValue({
          revokedAt: kind === 'untrusted' ? new Date() : null,
        });
        await expect(
          service.registerPushToken(
            'user-1',
            {
              token: 'ExponentPushToken[abc]',
              provider: 'expo',
              platform: 'ios',
            },
            'session',
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
      },
    );

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
      prisma.$queryRaw.mockResolvedValue([
        { id: 'n1', createdAt: new Date('2026-06-05T00:00:00Z') },
      ]);
      prisma.notification.findMany.mockResolvedValue([
        baseRow({
          id: 'n1',
          type: 'TRACE_COMMENT',
          content: 'nice',
          createdAt: new Date('2026-06-05T00:00:00Z'),
          fromUserID: 'u2',
          fromTraceID: 't1',
          fromReplyID: 'r1',
        }),
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u2', nickname: 'B', avatarUrl: null },
      ]);
      prisma.trace.findMany.mockResolvedValue([
        { id: 't1', content: 'my trace body', images: ['img1'] },
      ]);
      prisma.traceComment.findMany.mockResolvedValue([
        { id: 'r1', content: 'reply body' },
      ]);

      const result = await service.getNotifications('user-1', 1);

      // 第一页：只扫 id（索引自己回答），不带 OFFSET。
      const scan = prisma.$queryRaw.mock.calls[0][0];
      expect(scan.values).toEqual([
        'user-1',
        ...DISCOVER_NOTIFICATION_TYPES,
        20,
      ]);
      expect(scan.sql).not.toContain('OFFSET');
      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['n1'] },
          toUserID: 'user-1',
          deleted: false,
          type: { in: [...DISCOVER_NOTIFICATION_TYPES] },
        },
        select: NOTIFICATION_REALTIME_BASE_SELECT,
      });
      // 这一页只引用了用户 / 动态 / 回复：其余关系表一条都不查。
      for (const table of [
        prisma.circle,
        prisma.circlePost,
        prisma.circleInvitation,
        prisma.groupAdmission,
      ]) {
        expect(table.findMany).not.toHaveBeenCalled();
      }
      expect(prisma.systemAnnouncement.findMany).not.toHaveBeenCalled();
      expect(result[0]).toEqual({
        id: 'n1',
        type: 'TRACE_COMMENT',
        title: null,
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
      prisma.$queryRaw.mockResolvedValue([
        { id: 'sys-1', createdAt: new Date('2026-07-05T00:00:00Z') },
      ]);
      prisma.notification.findMany.mockResolvedValue([
        baseRow({
          id: 'sys-1',
          type: 'SYSTEM',
          content: '积分已到账 10',
        }),
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'user-1', nickname: 'Me', avatarUrl: null },
      ]);

      const result = await service.getProfileNotifications('user-1', 2);

      const scan = prisma.$queryRaw.mock.calls[0][0];
      expect(scan.values).toEqual(['user-1', 'SYSTEM', 20, 20]);
      expect(scan.sql).toContain('OFFSET');
      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['sys-1'] },
          toUserID: 'user-1',
          deleted: false,
          type: { in: ['SYSTEM'] },
        },
        select: NOTIFICATION_REALTIME_BASE_SELECT,
      });
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'sys-1',
          type: 'SYSTEM',
          content: '积分已到账 10',
          fromUser: { id: 'user-1', nickname: 'Me', avatarUrl: null },
        }),
      );
    });

    it('uses keyset pagination and returns an opaque next cursor', async () => {
      const rows = Array.from({ length: 21 }, (_, index) =>
        baseRow({
          id: `system-${index}`,
          type: 'SYSTEM',
          content: `system ${index}`,
          createdAt: new Date(Date.UTC(2026, 6, 21 - index)),
        }),
      );
      prisma.$queryRaw.mockResolvedValue(
        rows.map(({ id, createdAt }) => ({ id, createdAt })),
      );
      prisma.notification.findMany.mockResolvedValue(rows.slice(0, 20));
      const cursor = encodeNotificationCursor({
        createdAt: '2026-08-01T00:00:00.000Z',
        id: 'after-system-0',
      });

      const result = await service.getProfileNotificationsByCursor(
        'user-1',
        cursor,
      );

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const cursorQuery = prisma.$queryRaw.mock.calls[0][0] as {
        sql: string;
        values: unknown[];
      };
      expect(cursorQuery.sql).toContain('(n."createdAt", n."id") <');
      expect(cursorQuery.values).toEqual([
        'user-1',
        'SYSTEM',
        new Date('2026-08-01T00:00:00.000Z'),
        'after-system-0',
        21,
      ]);
      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: rows.slice(0, 20).map(({ id }) => id) },
          toUserID: 'user-1',
          deleted: false,
          type: { in: ['SYSTEM'] },
        },
        select: NOTIFICATION_REALTIME_BASE_SELECT,
      });
      expect(result.items).toHaveLength(20);
      expect(result.items.map((item) => item.id)).toEqual(
        rows.slice(0, 20).map(({ id }) => id),
      );
      expect(result.nextCursor).toBeTruthy();
      expect(decodeNotificationCursor(result.nextCursor!)).toEqual({
        createdAt: '2026-07-02T00:00:00.000Z',
        id: 'system-19',
      });
    });

    it('does not emit the lookahead row when a scanned page row disappears', async () => {
      const rows = Array.from({ length: 21 }, (_, index) =>
        baseRow({
          id: `system-${index}`,
          type: 'SYSTEM',
          createdAt: new Date(Date.UTC(2026, 6, 21 - index)),
        }),
      );
      prisma.$queryRaw.mockResolvedValue(
        rows.map(({ id, createdAt }) => ({ id, createdAt })),
      );
      prisma.notification.findMany.mockImplementation(async ({ where }) =>
        rows.filter(
          (row) => row.id !== 'system-0' && where.id.in.includes(row.id),
        ),
      );
      const page = await service.getProfileNotificationsByCursor(
        'user-1',
        encodeNotificationCursor({
          createdAt: '2026-08-01T00:00:00.000Z',
          id: 'cursor',
        }),
      );
      expect(page.items).toHaveLength(19);
      expect(page.items.some((item) => item.id === 'system-20')).toBe(false);
      expect(decodeNotificationCursor(page.nextCursor!)).toEqual({
        createdAt: rows[19].createdAt.toISOString(),
        id: 'system-19',
      });
    });

    it('advances past rows deleted during cursor hydration', async () => {
      const scanned = Array.from({ length: 21 }, (_, index) => ({
        id: `system-${index}`,
        createdAt: new Date(Date.UTC(2026, 6, 21 - index)),
      }));
      prisma.$queryRaw.mockResolvedValue(scanned);
      prisma.notification.findMany.mockResolvedValue([]);

      const result = await service.getProfileNotificationsByCursor(
        'user-1',
        encodeNotificationCursor({
          createdAt: '2026-08-01T00:00:00.000Z',
          id: 'after-system-0',
        }),
      );

      expect(result).toEqual({
        items: [],
        nextCursor: encodeNotificationCursor({
          createdAt: scanned[19].createdAt.toISOString(),
          id: scanned[19].id,
        }),
      });
    });

    it('rejects malformed notification cursors before querying', async () => {
      await expect(
        service.getProfileNotificationsByCursor('user-1', 'not-a-cursor'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
    });

    it('starts cursor pagination with a bounded first-page query', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.getNotificationsByCursor('user-1')).resolves.toEqual(
        { items: [], nextCursor: null },
      );

      const scan = prisma.$queryRaw.mock.calls[0][0];
      expect(scan.values).toEqual([
        'user-1',
        ...DISCOVER_NOTIFICATION_TYPES,
        21,
      ]);
      expect(scan.sql).not.toContain('OFFSET');
      expect(scan.sql).not.toContain('(n."createdAt", n."id") <');
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
    });

    it('enqueues durable push delivery after creating a friend request notification', async () => {
      prisma.notification.create.mockResolvedValue(
        baseRow({
          id: 'friend-n1',
          type: NotificationType.FRIEND_REQUEST_RECEIVED,
          content: 'hello',
          toUserID: 'to-1',
          fromUserID: 'from-1',
          fromFriendRequestID: 'request-1',
        }),
      );
      prisma.user.findMany.mockResolvedValue([
        { id: 'from-1', nickname: 'Aki', avatarUrl: null },
      ]);

      const result = await service.createFriendRequestNotification({
        type: NotificationType.FRIEND_REQUEST_RECEIVED,
        toUserId: 'to-1',
        fromUserId: 'from-1',
        content: 'hello',
        requestId: 'request-1',
      });

      expect(prisma.notificationPushOutbox.create).toHaveBeenCalledWith({
        data: { notificationID: 'friend-n1' },
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: 'friend-n1',
          fromUser: { id: 'from-1', nickname: 'Aki', avatarUrl: null },
          requestId: 'request-1',
        }),
      );
    });

    it('only creates inside the transaction and reads relations after it commits', async () => {
      const seenInTransaction: boolean[] = [];
      prisma.notification.create.mockImplementation(async () => {
        seenInTransaction.push(prisma.inTransaction);
        return baseRow({
          id: 'like-n1',
          type: NotificationType.TRACE_LIKE,
          toUserID: 'author-1',
          fromUserID: 'viewer-1',
          fromTraceID: 'trace-1',
        });
      });
      prisma.notification.findFirst.mockResolvedValue(null);
      prisma.user.findMany.mockImplementation(async () => {
        seenInTransaction.push(prisma.inTransaction);
        return [{ id: 'viewer-1', nickname: 'V', avatarUrl: null }];
      });
      prisma.trace.findMany.mockImplementation(async () => {
        seenInTransaction.push(prisma.inTransaction);
        return [{ id: 'trace-1', content: 'trace body', images: [] }];
      });

      const result = await service.createTraceLikeNotification({
        actorId: 'viewer-1',
        traceId: 'trace-1',
        traceOwnerId: 'author-1',
      });

      // create 在事务里，用户 / 动态两条关系查询都在提交之后。
      expect(seenInTransaction).toEqual([true, false, false]);
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          toUserID: 'author-1',
          fromUserID: 'viewer-1',
          type: NotificationType.TRACE_LIKE,
          fromTraceID: 'trace-1',
          content: '',
        },
        select: NOTIFICATION_REALTIME_BASE_SELECT,
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: 'like-n1',
          fromUser: { id: 'viewer-1', nickname: 'V', avatarUrl: null },
          fromTrace: { id: 'trace-1', excerpt: 'trace body', firstImage: null },
        }),
      );
    });

    it('fails the notification transaction when durable push enqueue fails', async () => {
      prisma.notification.create.mockResolvedValue(
        baseRow({
          id: 'friend-n2',
          type: NotificationType.FRIEND_REQUEST_RECEIVED,
          content: 'hello',
          fromUserID: 'from-1',
        }),
      );
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
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('creates circle invitation notifications through the shared notification path', async () => {
      prisma.notification.create.mockResolvedValue(
        baseRow({
          id: 'circle-inv-n1',
          type: NotificationType.CIRCLE_VERIFICATION_REQUESTED,
          toUserID: 'to-1',
          fromUserID: 'from-1',
          fromCircleID: 'circle-1',
          fromInvitationID: 'inv-1',
        }),
      );
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-1', name: 'Circle' },
      ]);
      prisma.circleInvitation.findMany.mockResolvedValue([
        { id: 'inv-1', status: 'PENDING' },
      ]);

      const result = await service.createCircleInvitationNotification({
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
        select: NOTIFICATION_REALTIME_BASE_SELECT,
      });
      expect(prisma.notificationPushOutbox.create).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          fromCircle: { id: 'circle-1', name: 'Circle' },
          fromInvitation: { id: 'inv-1', status: 'PENDING' },
        }),
      );
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
      const seenInTransaction: boolean[] = [];
      prisma.notification.create.mockImplementation(async () => {
        seenInTransaction.push(prisma.inTransaction);
        return baseRow({
          id: 'n-auto',
          type: NotificationType.CIRCLE_POST_AUTO_ENDED,
          createdAt: new Date('2026-06-29T12:00:00Z'),
          toUserID: 'author-1',
          fromUserID: 'author-1',
          fromCirclePostID: 'post-1',
        });
      });
      prisma.user.findMany.mockResolvedValue([
        { id: 'author-1', nickname: 'Host', avatarUrl: null },
      ]);
      prisma.circlePost.findMany.mockImplementation(async () => {
        seenInTransaction.push(prisma.inTransaction);
        return [{ id: 'post-1', content: 'Board game night', images: [] }];
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
        select: NOTIFICATION_REALTIME_BASE_SELECT,
      });
      expect(seenInTransaction).toEqual([true, false]);
      expect(result).toEqual(
        expect.objectContaining({
          id: 'n-auto',
          type: NotificationType.CIRCLE_POST_AUTO_ENDED,
          fromUser: { id: 'author-1', nickname: 'Host', avatarUrl: null },
          fromCirclePost: {
            id: 'post-1',
            excerpt: 'Board game night',
            firstImage: null,
          },
        }),
      );
    });

    it('creates published-post notifications and push outbox rows in the supplied transaction', async () => {
      const created = ['member-2', 'member-3'].map((toUserID, index) =>
        baseRow({
          id: `n${index + 2}`,
          type: NotificationType.CIRCLE_POST_PUBLISHED,
          createdAt: new Date('2026-06-29T12:00:00Z'),
          toUserID,
          fromUserID: 'author-1',
          fromCirclePostID: 'post-1',
        }),
      );
      const tx = {
        notification: {
          createManyAndReturn: jest.fn().mockResolvedValue(created),
          findMany: jest.fn(),
        },
        notificationPushOutbox: {
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        user: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'author-1', nickname: 'Host', avatarUrl: null },
            ]),
        },
        circlePost: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'post-1', content: 'hi', images: [] }]),
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
        select: NOTIFICATION_REALTIME_BASE_SELECT,
      });
      expect(tx.notificationPushOutbox.createMany).toHaveBeenCalledWith({
        data: [{ notificationID: 'n2' }, { notificationID: 'n3' }],
      });
      // INSERT ... RETURNING 已经带回本表列，不再整批回读；关系只查作者和帖子各一次。
      expect(tx.notification.findMany).not.toHaveBeenCalled();
      expect(tx.user.findMany).toHaveBeenCalledTimes(1);
      expect(tx.circlePost.findMany).toHaveBeenCalledTimes(1);
      expect(pushService.sendNotification).not.toHaveBeenCalled();
      expect(result).toEqual([
        {
          toUserId: 'member-2',
          notification: expect.objectContaining({
            id: 'n2',
            fromUser: { id: 'author-1', nickname: 'Host', avatarUrl: null },
            fromCirclePost: { id: 'post-1', excerpt: 'hi', firstImage: null },
          }),
        },
        {
          toUserId: 'member-3',
          notification: expect.objectContaining({ id: 'n3' }),
        },
      ]);
    });

    it('propagates push outbox creation failure to the caller transaction', async () => {
      const outboxError = new Error('outbox unavailable');
      const tx = {
        notification: {
          createManyAndReturn: jest.fn().mockResolvedValue([
            baseRow({
              id: 'n2',
              type: NotificationType.CIRCLE_POST_PUBLISHED,
              toUserID: 'member-2',
              fromUserID: 'author-1',
              fromCirclePostID: 'post-1',
            }),
          ]),
        },
        notificationPushOutbox: {
          createMany: jest.fn().mockRejectedValue(outboxError),
        },
        user: { findMany: jest.fn() },
        circlePost: { findMany: jest.fn() },
      } as unknown as Prisma.TransactionClient;

      await expect(
        service.createCirclePostPublishedNotifications(tx, {
          postId: 'post-1',
          fromUserId: 'author-1',
          recipientIds: ['member-2'],
        }),
      ).rejects.toBe(outboxError);
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(pushService.sendNotification).not.toHaveBeenCalled();
    });

    it('fans out trace comment notifications in precedence order and reads relations after commit', async () => {
      const seenInTransaction: boolean[] = [];
      const inserted = [
        baseRow({
          id: 'n-owner',
          type: NotificationType.TRACE_COMMENT,
          content: 'hey',
          toUserID: 'owner',
          fromUserID: 'actor',
          fromTraceID: 'trace-1',
          fromReplyID: 'comment-1',
        }),
        baseRow({
          id: 'n-reply',
          type: NotificationType.COMMENT_REPLY,
          content: 'hey',
          toUserID: 'replied',
          fromUserID: 'actor',
          fromTraceID: 'trace-1',
          fromReplyID: 'comment-1',
        }),
      ];
      prisma.notification.createManyAndReturn.mockImplementation(async () => {
        seenInTransaction.push(prisma.inTransaction);
        return inserted;
      });
      prisma.notificationPushOutbox.createMany.mockResolvedValue({ count: 2 });
      prisma.user.findMany.mockImplementation(async () => {
        seenInTransaction.push(prisma.inTransaction);
        return [{ id: 'actor', nickname: 'A', avatarUrl: null }];
      });
      prisma.trace.findMany.mockResolvedValue([
        { id: 'trace-1', content: 'trace', images: [] },
      ]);
      prisma.traceComment.findMany.mockResolvedValue([
        { id: 'comment-1', content: 'hey' },
      ]);

      const result = await service.createTraceCommentNotifications({
        actorId: 'actor',
        traceId: 'trace-1',
        commentId: 'comment-1',
        traceOwnerId: 'owner',
        replyToCommentId: 'parent-1',
        replyToUserId: 'replied',
        content: 'hey',
      });

      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ select: NOTIFICATION_REALTIME_BASE_SELECT }),
      );
      expect(prisma.notificationPushOutbox.createMany).toHaveBeenCalledWith({
        data: [{ notificationID: 'n-owner' }, { notificationID: 'n-reply' }],
      });
      expect(prisma.notification.findMany).not.toHaveBeenCalled();
      expect(seenInTransaction).toEqual([true, false]);
      expect(result).toEqual([
        {
          targetUserId: 'owner',
          notification: expect.objectContaining({
            id: 'n-owner',
            fromReply: { id: 'comment-1', content: 'hey' },
          }),
        },
        {
          targetUserId: 'replied',
          notification: expect.objectContaining({ id: 'n-reply' }),
        },
      ]);
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

  describe('圈子离线推送开关', () => {
    it('只读当前用户自己的那一行，且只取这一列', async () => {
      prisma.user.findUnique.mockResolvedValue({
        circleOfflinePushEnabled: false,
      });

      await expect(service.getCirclePushPreference('user-1')).resolves.toEqual({
        circleOfflinePushEnabled: false,
      });
      // 显式 select：User 行上挂着密码哈希、邮箱、管理员标志，读一整行再取一个
      // 字段等于把它们拉进进程。where 只认 JWT 里的 id，不接受任何外部入参。
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { circleOfflinePushEnabled: true },
      });
    });

    // 老账号在迁移之前没有这一行/这一列时按默认值「收」处理 —— 与该开关上线前
    // 的行为一致，不能因为读不到就静默把人家的推送关掉。
    it('查不到用户行时回落到默认值 true', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getCirclePushPreference('user-1')).resolves.toEqual({
        circleOfflinePushEnabled: true,
      });
    });

    it('写入也只落在当前用户自己的那一行，并回显库里的值', async () => {
      prisma.user.update.mockResolvedValue({ circleOfflinePushEnabled: false });

      await expect(
        service.setCirclePushPreference('user-1', false),
      ).resolves.toEqual({ circleOfflinePushEnabled: false });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { circleOfflinePushEnabled: false },
        select: { circleOfflinePushEnabled: true },
      });
    });

    it('开回来也走同一条路径', async () => {
      prisma.user.update.mockResolvedValue({ circleOfflinePushEnabled: true });

      await expect(
        service.setCirclePushPreference('user-1', true),
      ).resolves.toEqual({ circleOfflinePushEnabled: true });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { circleOfflinePushEnabled: true },
        }),
      );
    });
  });
});

describe('scrolling announcements', () => {
  it('updates the selection and writes its audit within the same transaction', async () => {
    const tx = {
      $queryRaw: jest.fn(),
      systemAnnouncement: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'a', fanoutCompletedAt: new Date() }),
        update: jest.fn().mockResolvedValue({ id: 'a', scrolling: false }),
      },
    };
    const prisma = {
      notification: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'n-a', toUserID: 'user-a' }]),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const audit = { recordStrict: jest.fn() };
    const realtime = { broadcastAnnouncementChanged: jest.fn() };
    const service = new NotificationService(
      prisma as any,
      realtime as any,
      undefined,
      audit as any,
    );
    expect(await service.setAnnouncementScrolling('admin', 'a', false)).toEqual(
      { id: 'a', scrolling: false },
    );
    expect(realtime.broadcastAnnouncementChanged).toHaveBeenCalledWith(
      'user-a',
    );
    expect(audit.recordStrict).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorID: 'admin',
        entityID: 'a',
        after: { scrolling: false },
      }),
    );
    expect(tx.systemAnnouncement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a' },
        data: { scrolling: false },
      }),
    );
  });
  it('replaces the previous selection under the same transaction lock', async () => {
    const tx = {
      $queryRaw: jest.fn(),
      systemAnnouncement: {
        findMany: jest.fn().mockResolvedValue([{ id: 'old' }]),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'new', fanoutCompletedAt: new Date() }),
        updateMany: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'new', scrolling: true }),
      },
    };
    const prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'n-old', toUserID: 'old-recipient' },
          { id: 'n-new', toUserID: 'new-recipient' },
        ]),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const realtime = { broadcastAnnouncementChanged: jest.fn() };
    const service = new NotificationService(
      prisma as any,
      realtime as any,
      undefined,
      { recordStrict: jest.fn() } as any,
    );
    await service.setAnnouncementScrolling('admin', 'new', true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    // 每条受影响的公告各自沿唯一索引 (systemAnnouncementID, toUserID) 翻页。
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { systemAnnouncementID: 'new', toUserID: { not: null } },
        orderBy: { toUserID: 'asc' },
      }),
    );
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { systemAnnouncementID: 'old', toUserID: { not: null } },
        orderBy: { toUserID: 'asc' },
      }),
    );
    expect(realtime.broadcastAnnouncementChanged).toHaveBeenCalledWith(
      'old-recipient',
    );
    expect(realtime.broadcastAnnouncementChanged).toHaveBeenCalledWith(
      'new-recipient',
    );
    expect(tx.systemAnnouncement.updateMany).toHaveBeenCalledWith({
      where: { scrolling: true, id: { not: 'new' } },
      data: { scrolling: false },
    });
    expect(
      tx.systemAnnouncement.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.systemAnnouncement.update.mock.invocationCallOrder[0]);
  });
  it('returns the recipient notification ID for the shared detail page', async () => {
    const row = {
      id: 'announcement-id',
      title: 'Title',
      content: 'Body',
      createdAt: new Date(),
      notifications: [{ id: 'recipient-notification' }],
    };
    const service = new NotificationService(
      {
        systemAnnouncement: { findMany: jest.fn().mockResolvedValue([row]) },
      } as any,
      {} as any,
    );
    expect(await service.scrollingAnnouncements('user-a')).toEqual({
      items: [
        expect.objectContaining({ notificationID: 'recipient-notification' }),
      ],
    });
  });
  it('returns only selected, published announcements delivered to this user', async () => {
    const prisma = {
      systemAnnouncement: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new NotificationService(
      prisma as any,
      {} as any,
      {} as any,
    );
    expect(await service.scrollingAnnouncements('user-a')).toEqual({
      items: [],
    });
    expect(prisma.systemAnnouncement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          scrolling: true,
          deletedAt: null,
          fanoutCompletedAt: { not: null },
          notifications: { some: { toUserID: 'user-a', deleted: false } },
        },
        take: 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});

describe('profile notification details ownership', () => {
  it('scopes full content to the current recipient and excludes deleted or non-profile notifications', async () => {
    const prisma = {
      notification: {
        findFirst: jest.fn().mockResolvedValue(
          baseRow({
            id: 'n',
            type: 'SYSTEM',
            content: 'full body',
            toUserID: 'user-a',
            fromUserID: 'user-a',
            systemAnnouncementID: 'a-1',
          }),
        ),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'user-a', nickname: 'A', avatarUrl: null },
          ]),
      },
      systemAnnouncement: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'a-1', title: '公告标题' }]),
      },
    };
    const service = new NotificationService(prisma as any, {} as any);
    expect(await service.profileNotificationDetail('user-a', 'n')).toEqual(
      expect.objectContaining({ content: 'full body', title: '公告标题' }),
    );
    expect(prisma.notification.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'n',
        toUserID: 'user-a',
        deleted: false,
        type: expect.objectContaining({ in: expect.any(Array) }),
      }),
      select: NOTIFICATION_REALTIME_BASE_SELECT,
    });
  });
  it('does not return another user notification', async () => {
    const service = new NotificationService(
      { notification: { findFirst: jest.fn().mockResolvedValue(null) } } as any,
      {} as any,
    );
    await expect(
      service.profileNotificationDetail('user-b', 'n'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('editing and deleting announcements', () => {
  type RecipientRow = { id: string; toUserID: string | null };
  type FindArgs = {
    where: {
      toUserID?: null | { not: null } | { gt: string };
      id?: { gt: string };
    };
    orderBy: { toUserID?: 'asc'; id?: 'asc' };
    take: number;
  };

  /** 按 Prisma 的 where/orderBy/take 在内存里翻页,桩出键集分页的真实行为。 */
  function page(rows: readonly RecipientRow[], args: FindArgs) {
    const { toUserID, id } = args.where;
    const kept = rows.filter((row) => {
      if (toUserID === null && row.toUserID !== null) return false;
      if (toUserID && 'not' in toUserID && row.toUserID === null) return false;
      if (
        toUserID &&
        'gt' in toUserID &&
        (row.toUserID === null || row.toUserID <= toUserID.gt)
      )
        return false;
      if (id && row.id <= id.gt) return false;
      return true;
    });
    const key = args.orderBy.toUserID ? 'toUserID' : 'id';
    return [...kept]
      .sort((a, b) => String(a[key]).localeCompare(String(b[key])))
      .slice(0, args.take);
  }

  /** 2345 个有收件人的行(分 1000/1000/345 三批)+ 2 个收件人已被物理删除的老行。 */
  const MANY_ROWS: RecipientRow[] = [
    ...Array.from({ length: 2345 }, (_, index) => ({
      id: `n-${String(index).padStart(4, '0')}`,
      toUserID: `u-${String(index).padStart(4, '0')}`,
    })),
    { id: 'n-orphan-1', toUserID: null },
    { id: 'n-orphan-2', toUserID: null },
  ];

  function harness({
    row = { id: 'a', fanoutCompletedAt: new Date() } as unknown,
    rows = [{ id: 'n', toUserID: 'u' }] as RecipientRow[],
    current = { content: 'New body', deletedAt: null as Date | null },
  } = {}) {
    // events 记录每个事务的边界与其中的语句,用来断言「一批一个短事务」和先后次序。
    const events: string[] = [];
    const record =
      <T>(name: string, value?: T) =>
      async (...args: unknown[]) => {
        events.push(name);
        return typeof value === 'function'
          ? (value as (...inner: unknown[]) => unknown)(...args)
          : value;
      };
    const tx = {
      $queryRaw: jest.fn(record('lock', [])),
      systemAnnouncement: {
        findFirst: jest.fn(record('announcement.check', row)),
        findUnique: jest.fn(record('announcement.read', current)),
        update: jest.fn(record('announcement.update', { id: 'a' })),
      },
      notification: {
        findMany: jest.fn(
          record('notification.page', (args: FindArgs) => page(rows, args)),
        ),
        updateMany: jest.fn(record('notification.updateMany', { count: 0 })),
      },
      notificationPushOutbox: {
        updateMany: jest.fn(record('outbox.updateMany', { count: 0 })),
      },
      notificationPushDelivery: {
        updateMany: jest.fn(record('delivery.updateMany', { count: 0 })),
      },
    };
    const prisma = {
      systemAnnouncement: tx.systemAnnouncement,
      notification: {
        findMany: jest.fn(async (args: FindArgs) => page(rows, args)),
      },
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
        events.push('begin');
        const result = await fn(tx);
        events.push('commit');
        return result;
      }),
    };
    const audit = { recordStrict: jest.fn(record('audit')) };
    const realtime = { broadcastAnnouncementChanged: jest.fn() };
    return {
      tx,
      prisma,
      audit,
      realtime,
      events,
      service: new NotificationService(
        prisma as any,
        realtime as any,
        undefined,
        audit as any,
      ),
    };
  }

  /** 事务列表:每个元素是一个 begin…commit 之间的语句名。 */
  const transactions = (events: readonly string[]) => {
    const result: string[][] = [];
    let current: string[] | null = null;
    for (const event of events) {
      if (event === 'begin') current = [];
      else if (event === 'commit') {
        if (current) result.push(current);
        current = null;
      } else current?.push(event);
    }
    return result;
  };

  const updatedIds = (mock: jest.Mock) =>
    mock.mock.calls.flatMap(
      ([args]: [{ where: { id: { in: string[] } } }]) => args.where.id.in,
    );

  it('updates the title and all live recipient bodies without sending another push', async () => {
    const { service, tx, audit, realtime } = harness();
    await service.editAnnouncement('admin', 'a', {
      title: 'New title',
      content: 'New body',
    });
    expect(tx.systemAnnouncement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { title: 'New title', content: 'New body' },
      }),
    );
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['n'] }, deleted: false },
      data: { content: 'New body' },
    });
    expect(tx.notificationPushOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        notificationID: { in: ['n'] },
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: { payload: Prisma.DbNull },
    });
    expect(realtime.broadcastAnnouncementChanged).toHaveBeenCalledWith('u');
    expect(audit.recordStrict).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'system_announcement_edit' }),
    );
  });

  it('hides recipient notifications, stops scrolling and cancels unfinished pushes', async () => {
    const { service, tx, audit, realtime } = harness();
    expect(await service.deleteAnnouncement('admin', 'a')).toEqual({
      deleted: true,
    });
    expect(realtime.broadcastAnnouncementChanged).toHaveBeenCalledWith('u');
    expect(tx.systemAnnouncement.update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { deletedAt: expect.any(Date), scrolling: false },
    });
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['n'] } },
      data: { deleted: true },
    });
    expect(tx.notificationPushOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        notificationID: { in: ['n'] },
        status: { in: ['PENDING', 'FAILED', 'PROCESSING'] },
      },
      data: {
        status: 'TERMINAL',
        completionReason: 'ANNOUNCEMENT_DELETED',
        leaseToken: null,
        lockedAt: null,
      },
    });
    expect(tx.notificationPushDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        outbox: { notificationID: { in: ['n'] } },
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: { status: 'TERMINAL', lastError: 'ANNOUNCEMENT_DELETED' },
    });
    expect(audit.recordStrict).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'system_announcement_delete' }),
    );
  });

  it('rejects deleted and still-publishing announcements before changing recipient data', async () => {
    for (const row of [null, { id: 'a', fanoutCompletedAt: null }]) {
      for (const run of [
        (service: NotificationService) =>
          service.deleteAnnouncement('admin', 'a'),
        (service: NotificationService) =>
          service.editAnnouncement('admin', 'a', { title: 't', content: 'x' }),
      ]) {
        const { service, tx } = harness({ row });
        await expect(run(service)).rejects.toBeDefined();
        expect(tx.notification.updateMany).not.toHaveBeenCalled();
        expect(tx.notificationPushOutbox.updateMany).not.toHaveBeenCalled();
      }
    }
  });

  // 改动前是一条 updateMany WHERE systemAnnouncementID = $1 改全员的行:几十万行一条
  // 语句、一个事务,锁住所有收件人的通知行直到提交,还会撞 5 秒事务超时 / 15 秒语句
  // 超时。现在按收件人键集每批 1000 行,一批一个短事务。
  it('edits recipient rows in keyset batches of 1000, one short transaction each', async () => {
    const { service, tx, events } = harness({ rows: MANY_ROWS });
    await service.editAnnouncement('admin', 'a', {
      title: 'New title',
      content: 'New body',
    });

    // 一个改公告 + 审计的事务,然后四个批次事务(1000/1000/345 + 2 个孤儿行)。
    const txs = transactions(events);
    expect(txs[0]).toEqual([
      'lock',
      'announcement.check',
      'announcement.update',
      'audit',
    ]);
    expect(txs.slice(1)).toHaveLength(4);
    for (const batch of txs.slice(1)) {
      expect(batch).toEqual([
        'lock',
        'notification.page',
        'announcement.read',
        'notification.updateMany',
        'outbox.updateMany',
      ]);
    }
    for (const [args] of tx.notification.updateMany.mock.calls as any[][]) {
      expect(args.where.id.in.length).toBeLessThanOrEqual(1000);
      expect(args).toEqual({
        where: { id: { in: expect.any(Array) }, deleted: false },
        data: { content: 'New body' },
      });
    }
    expect(new Set(updatedIds(tx.notification.updateMany))).toEqual(
      new Set(MANY_ROWS.map((row) => row.id)),
    );
    expect(updatedIds(tx.notification.updateMany)).toHaveLength(
      MANY_ROWS.length,
    );
    expect(
      (tx.notificationPushOutbox.updateMany.mock.calls as any[][]).flatMap(
        ([args]) => args.where.notificationID.in as string[],
      ),
    ).toHaveLength(MANY_ROWS.length);
    // 翻页走唯一索引 (systemAnnouncementID, toUserID);收件人为 NULL 的老行最后按 id 补。
    expect(tx.notification.findMany.mock.calls.map(([args]) => args)).toEqual([
      {
        where: { systemAnnouncementID: 'a', toUserID: { not: null } },
        select: { id: true, toUserID: true },
        orderBy: { toUserID: 'asc' },
        take: 1000,
      },
      expect.objectContaining({
        where: { systemAnnouncementID: 'a', toUserID: { gt: 'u-0999' } },
      }),
      expect.objectContaining({
        where: { systemAnnouncementID: 'a', toUserID: { gt: 'u-1999' } },
      }),
      {
        where: { systemAnnouncementID: 'a', toUserID: null },
        select: { id: true, toUserID: true },
        orderBy: { id: 'asc' },
        take: 1000,
      },
    ]);
  });

  it('propagates the committed announcement body, so a later concurrent edit wins everywhere', async () => {
    const { service, tx } = harness({
      current: { content: 'Body from a newer edit', deletedAt: null },
    });
    await service.editAnnouncement('admin', 'a', {
      title: 'Title',
      content: 'Older body',
    });
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['n'] }, deleted: false },
      data: { content: 'Body from a newer edit' },
    });
  });

  it('stops propagating an edit once the announcement has been deleted', async () => {
    const { service, tx } = harness({
      rows: MANY_ROWS,
      current: { content: 'New body', deletedAt: new Date() },
    });
    await service.editAnnouncement('admin', 'a', {
      title: 'Title',
      content: 'New body',
    });
    expect(tx.notification.updateMany).not.toHaveBeenCalled();
    expect(tx.notification.findMany).toHaveBeenCalledTimes(1);
  });

  it('deletes recipient rows in batches first and retires the announcement last', async () => {
    const { service, tx, events } = harness({ rows: MANY_ROWS });
    await service.deleteAnnouncement('admin', 'a');

    const txs = transactions(events);
    const batches = txs.filter((statements) =>
      statements.includes('notification.updateMany'),
    );
    expect(batches).toHaveLength(4);
    for (const batch of batches) {
      expect(batch).toEqual([
        'lock',
        'notification.page',
        'notification.updateMany',
        'outbox.updateMany',
        'delivery.updateMany',
      ]);
    }
    // 收件人数据处理完之后,才在一个短事务里复核、下线公告并写审计 —— 中途失败时公告
    // 仍然可删,重试会把剩下的批次做完,不会卡在「公告已删、通知还在」的状态。
    expect(txs[txs.length - 1]).toEqual([
      'lock',
      'announcement.check',
      'announcement.update',
      'audit',
    ]);
    expect(new Set(updatedIds(tx.notification.updateMany))).toEqual(
      new Set(MANY_ROWS.map((row) => row.id)),
    );
    expect(updatedIds(tx.notification.updateMany)).toHaveLength(
      MANY_ROWS.length,
    );
    for (const [args] of tx.notificationPushDelivery.updateMany.mock
      .calls as any[][]) {
      expect(args.where.outbox.notificationID.in.length).toBeLessThanOrEqual(
        1000,
      );
    }
  });
});

describe('announcement fan-out mutex', () => {
  const createdAt = new Date('2026-07-29T12:00:00.000Z');

  function harness(lease: string | null | undefined) {
    const recipients = Array.from({ length: 501 }, (_, index) => ({
      id: `user-${String(index).padStart(3, '0')}`,
    }));
    const prisma: Record<string, any> = {
      $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
      systemAnnouncement: {
        upsert: jest.fn().mockResolvedValue({
          id: 'announcement-1',
          requestFingerprint: 'admin-1:Maintenance',
          createdAt,
          auditRecordedAt: null,
          fanoutCompletedAt: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(recipients.slice(0, 500))
          .mockResolvedValueOnce(recipients.slice(500))
          .mockResolvedValue([]),
      },
      notification: {
        createManyAndReturn: jest.fn(async ({ data }) =>
          data.map((row: { toUserID: string }) => ({
            id: `n-${row.toUserID}`,
            toUserID: row.toUserID,
          })),
        ),
        count: jest.fn().mockResolvedValue(501),
      },
      notificationPushOutbox: { createMany: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const redis = {
      tryAcquireLease: jest.fn().mockResolvedValue(lease),
      renewLease: jest.fn().mockResolvedValue(true),
      releaseLease: jest.fn().mockResolvedValue(undefined),
    };
    const realtime = {
      broadcastSystemNotificationUnreadToRecipients: jest.fn(),
    };
    const service = new NotificationService(
      prisma as any,
      realtime as any,
      undefined,
      { recordStrict: jest.fn() } as any,
      redis as any,
    );
    return { prisma, redis, service };
  }

  const publish = (service: NotificationService) =>
    service.publishSystemAnnouncement(
      'admin-1',
      { content: 'Maintenance' },
      'announcement-request-1',
    );

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 改动前:外层 $transaction(timeout 600_000)只为持有 pg_try_advisory_xact_lock,
  // 扇出期间(最长 10 分钟)占着一个 idle in transaction 的连接。
  it('holds the fan-out mutex as a Redis lease, not an open database transaction', async () => {
    const { prisma, redis, service } = harness('lease-token');

    await expect(publish(service)).resolves.toEqual({ createdCount: 501 });

    expect(redis.tryAcquireLease).toHaveBeenCalledWith(
      'job-lease:system-announcement-fanout',
      60_000,
    );
    expect(redis.releaseLease).toHaveBeenCalledWith(
      'job-lease:system-announcement-fanout',
      'lease-token',
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    for (const call of prisma.$transaction.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledTimes(2);
  });

  it('rejects with 429 while another replica holds the lease', async () => {
    const { prisma, service } = harness(null);

    await expect(publish(service)).rejects.toMatchObject({ status: 429 });
    expect(prisma.systemAnnouncement.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // Redis 未配置 / 这一刻答不上来:退回原来的数据库锁,互斥不弱于改动前。
  it('falls back to the database advisory lock when Redis cannot answer', async () => {
    const { prisma, service } = harness(undefined);

    await expect(publish(service)).resolves.toEqual({ createdCount: 501 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 600_000,
    });
  });

  it('falls back to the database advisory lock when Redis is not wired in', async () => {
    const { prisma } = harness(undefined);
    const service = new NotificationService(
      prisma as any,
      { broadcastSystemNotificationUnreadToRecipients: jest.fn() } as any,
      undefined,
      { recordStrict: jest.fn() } as any,
    );
    prisma.$queryRaw.mockResolvedValueOnce([{ acquired: false }]);

    await expect(publish(service)).rejects.toMatchObject({ status: 429 });
    expect(prisma.systemAnnouncement.upsert).not.toHaveBeenCalled();
  });

  it('stops before the next batch once the lease can no longer be renewed', async () => {
    const { prisma, service } = harness('lease-token');
    const startedAt = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(startedAt);
    prisma.notification.createManyAndReturn.mockImplementationOnce(
      async ({ data }: { data: Array<{ toUserID: string }> }) => {
        // 第一批写完之后租约已过期(续租没成功):不能再开下一批。
        clock.mockReturnValue(startedAt + 120_000);
        return data.map((row) => ({
          id: `n-${row.toUserID}`,
          toUserID: row.toUserID,
        }));
      },
    );

    await expect(publish(service)).rejects.toMatchObject({ status: 503 });
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.systemAnnouncement.updateMany).not.toHaveBeenCalled();
  });
});

describe('push token registration connection usage', () => {
  const dto = {
    token: 'ExponentPushToken[abc]',
    platform: 'ios',
    provider: 'expo',
  } as const;

  function harness() {
    const order: string[] = [];
    const step = (name: string, value: unknown) => async () => {
      order.push(name);
      return value;
    };
    const tx = {
      $executeRaw: jest.fn(step('lock', 1)),
      refreshToken: {
        findUnique: jest.fn(
          step('session', {
            userId: 'user-1',
            audience: 'APP',
            deviceKey: 'device-1',
            familyId: 'family-1',
            expiredAt: new Date(Date.now() + 60_000),
            revokedAt: new Date(),
            revocationReason: 'ROTATED',
          }),
        ),
        findFirst: jest.fn(step('live-session', { id: 'live' })),
      },
      trustedDevice: {
        findUnique: jest.fn(step('trusted-device', { revokedAt: null })),
      },
      devicePushToken: {
        updateMany: jest.fn(step('claim', { count: 0 })),
        create: jest.fn(step('create', { id: 'row' })),
        findMany: jest.fn(step('excess', [{ id: 'old-row' }])),
        deleteMany: jest.fn(step('prune', { count: 1 })),
      },
    };
    const untouched = () => ({
      refreshToken: { findUnique: jest.fn(), findFirst: jest.fn() },
      trustedDevice: { findUnique: jest.fn() },
      devicePushToken: {
        updateMany: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    });
    const prisma = {
      ...untouched(),
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new NotificationService(prisma as any, {} as any);
    return { tx, prisma, order, service };
  }

  // 改动前:事务占一个连接持有 auth_session 锁,里面约 8 条语句却走 this.prisma,
  // 每条再从池里借第二个连接。现在全部走持锁的那个事务连接。
  it('runs every registration statement on the transaction connection that holds the session lock', async () => {
    const { tx, prisma, order, service } = harness();

    await expect(
      service.registerPushToken('user-1', dto, 'session-1'),
    ).resolves.toEqual({ deviceBound: true });

    expect(order).toEqual([
      'lock',
      'session',
      'live-session',
      'trusted-device',
      'claim',
      'create',
      'excess',
      'prune',
    ]);
    expect(tx.devicePushToken.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-row'] } },
    });
    for (const delegate of [
      prisma.refreshToken,
      prisma.trustedDevice,
      prisma.devicePushToken,
    ]) {
      for (const method of Object.values(delegate)) {
        expect(method).not.toHaveBeenCalled();
      }
    }
  });

  it('issues nothing after a lost token race aborts the transaction', async () => {
    const { tx, service } = harness();
    tx.devicePushToken.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    await expect(
      service.registerPushToken('user-1', dto, 'session-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.devicePushToken.findMany).not.toHaveBeenCalled();
    expect(tx.devicePushToken.deleteMany).not.toHaveBeenCalled();
  });

  // 仍然占 auth 的数据库名额:它在持有连接的状态下排队等 auth_session 锁,而锁的持有者
  // (登录 / 刷新 / 设备信任)在锁内还要借嵌套连接。不限并发的话,同一账号的一串
  // 登记请求就能占满连接池,让持锁者借不到连接 —— 正是名额要防的池死锁。
  it('still shares the auth database work budget', async () => {
    const { prisma, service } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    prisma.$transaction.mockImplementation(async () => {
      await gate;
      return { deviceBound: false };
    });

    const calls = Array.from({ length: 4 }, () =>
      service.registerPushToken('user-1', dto),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);

    release();
    await Promise.all(calls);
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
  });
});
