import { ConfigService } from '@nestjs/config';
import { NotificationService } from 'src/notification/notification.service';
import { NotificationPushService } from 'src/notification/notification-push.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { TraceService } from './trace.service';

describe('trace comment mention notification flow', () => {
  const prisma = {
    trace: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    traceComment: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    friend: {
      findMany: jest.fn(),
    },
    userPrivacySetting: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    notification: {
      createManyAndReturn: jest.fn(),
      findMany: jest.fn(),
    },
    notificationPushOutbox: {
      createMany: jest.fn(),
    },
    $transaction: jest.fn(async (input: any) =>
      Array.isArray(input) ? Promise.all(input) : input(prisma),
    ),
  };
  const realtime = {
    broadcastInteractionUnread: jest.fn().mockResolvedValue(undefined),
    broadcastSystemNotificationUnread: jest.fn().mockResolvedValue(undefined),
    broadcastNotificationCreated: jest.fn(),
    broadcastCirclePostInteractionCreated: jest.fn(),
  };
  const push = {
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };

  let traceService: TraceService;

  beforeEach(() => {
    prisma.trace.findFirst.mockReset();
    prisma.trace.update.mockReset();
    prisma.traceComment.findFirst.mockReset();
    prisma.traceComment.create.mockReset();
    prisma.user.findMany.mockReset();
    prisma.friend.findMany.mockReset();
    prisma.userPrivacySetting.findMany.mockReset();
    prisma.userPrivacySetting.findUnique.mockReset();
    prisma.notification.createManyAndReturn.mockReset();
    prisma.notification.findMany.mockReset();
    prisma.notificationPushOutbox.createMany.mockReset();
    prisma.$transaction
      .mockReset()
      .mockImplementation(async (input: any) =>
        Array.isArray(input) ? Promise.all(input) : input(prisma),
      );
    realtime.broadcastInteractionUnread.mockReset();
    realtime.broadcastSystemNotificationUnread.mockReset();
    realtime.broadcastNotificationCreated.mockReset();
    realtime.broadcastCirclePostInteractionCreated.mockReset();
    push.sendNotification.mockReset();
    realtime.broadcastInteractionUnread.mockResolvedValue(undefined);
    push.sendNotification.mockResolvedValue(undefined);

    const privacySettings = new PrivacySettingsService(
      prisma as unknown as PrismaService,
    );
    const notificationService = new NotificationService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      push as unknown as NotificationPushService,
    );
    traceService = new TraceService(
      prisma as unknown as PrismaService,
      { get: jest.fn(() => null) } as unknown as ConfigService,
      notificationService,
      realtime as unknown as RealtimeService,
      privacySettings,
    );

    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceComment.findFirst.mockResolvedValue({
      id: 'parent-comment-1',
      traceID: 'trace-1',
      deleted: false,
    });
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00Z'),
      user: { id: 'actor-1', nickname: 'Aki' },
      replyTo: {
        id: 'parent-comment-1',
        user: { id: 'reply-user-1', nickname: 'Rin' },
      },
    });
    prisma.trace.update.mockResolvedValue({});
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.userPrivacySetting.findMany.mockResolvedValue([]);
    // Notifications are written with one createManyAndReturn and hydrated by a
    // follow-up findMany, so the mock keeps the inserted rows to serve back.
    let insertedRows: any[] = [];
    prisma.notification.createManyAndReturn.mockImplementation(
      ({ data }: any) => {
        insertedRows = data.map((row: any) => ({
          id: `notification-${row.toUserID}`,
          ...row,
          content: row.content ?? '',
          read: false,
          createdAt: new Date('2026-07-10T00:00:01Z'),
          fromUser: { id: 'actor-1', nickname: 'Aki', avatarUrl: null },
          fromTrace: { id: 'trace-1', content: 'trace body', images: [] },
          fromReply: { id: 'comment-1', content: 'hello' },
          fromCircle: null,
          fromCirclePost: null,
          fromInvitation: null,
        }));
        return Promise.resolve(insertedRows.map(({ id }) => ({ id })));
      },
    );
    // Reversed on purpose: findMany gives no order guarantee, so the service
    // must restore insertion order itself.
    prisma.notification.findMany.mockImplementation(({ where }: any) => {
      const ids = new Set(where.id.in);
      return Promise.resolve(
        insertedRows.filter((row) => ids.has(row.id)).reverse(),
      );
    });
  });

  it('delivers one eligible mention while reply overlap keeps higher precedence', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'reply-user-1' },
      { id: 'mention-user-1' },
    ]);

    await traceService.addComment('actor-1', 'trace-1', {
      content: 'hello',
      replyToId: 'parent-comment-1',
      mentionedUserIds: ['reply-user-1', 'mention-user-1'],
    });

    // One batched insert carrying both rows in precedence order, not one
    // round-trip per recipient.
    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(
      prisma.notification.createManyAndReturn.mock.calls[0][0].data,
    ).toEqual([
      expect.objectContaining({
        toUserID: 'reply-user-1',
        type: 'COMMENT_REPLY',
      }),
      expect.objectContaining({
        toUserID: 'mention-user-1',
        type: 'TRACE_MENTION',
        fromTraceID: 'trace-1',
        fromReplyID: 'comment-1',
      }),
    ]);
    expect(prisma.notificationPushOutbox.createMany).toHaveBeenCalledTimes(1);
    expect(
      prisma.notificationPushOutbox.createMany.mock.calls[0][0].data,
    ).toEqual([
      { notificationID: 'notification-reply-user-1' },
      { notificationID: 'notification-mention-user-1' },
    ]);
    expect(push.sendNotification).not.toHaveBeenCalled();
    expect(realtime.broadcastNotificationCreated).toHaveBeenCalledTimes(2);
    expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
      'mention-user-1',
      expect.objectContaining({ type: 'TRACE_MENTION' }),
    );
  });

  it('skips a revoked mention while preserving the reply notification at the boundary', async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'mention-user-1' }])
      .mockResolvedValueOnce([]);

    await expect(
      traceService.addComment('actor-1', 'trace-1', {
        content: 'hello',
        replyToId: 'parent-comment-1',
        mentionedUserIds: ['mention-user-1'],
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'comment-1' }));

    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.notification.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(
      prisma.notification.createManyAndReturn.mock.calls[0][0].data,
    ).toEqual([
      expect.objectContaining({
        toUserID: 'reply-user-1',
        type: 'COMMENT_REPLY',
      }),
    ]);
    expect(prisma.notificationPushOutbox.createMany).toHaveBeenCalledTimes(1);
    expect(push.sendNotification).not.toHaveBeenCalled();
    expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
      'reply-user-1',
      expect.objectContaining({ type: 'COMMENT_REPLY' }),
    );
  });

  it('blocks all notification side effects when the trace is deleted after preflight', async () => {
    prisma.trace.findFirst
      .mockResolvedValueOnce({
        id: 'trace-1',
        fromID: 'actor-1',
        deleted: false,
        visibility: 'PUBLIC',
      })
      .mockResolvedValueOnce(null);
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);

    await traceService.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['mention-user-1'],
    });

    expect(prisma.trace.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'trace-1', deleted: false },
      select: { fromID: true, visibility: true },
    });
    expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    expect(
      prisma.$transaction.mock.calls.some(([operations]) =>
        Array.isArray(operations),
      ),
    ).toBe(false);
    expect(push.sendNotification).not.toHaveBeenCalled();
    expect(realtime.broadcastInteractionUnread).not.toHaveBeenCalled();
    expect(realtime.broadcastNotificationCreated).not.toHaveBeenCalled();
    expect(
      realtime.broadcastCirclePostInteractionCreated,
    ).not.toHaveBeenCalled();
  });

  it('blocks all notification side effects when trace visibility changes after preflight', async () => {
    prisma.trace.findFirst
      .mockResolvedValueOnce({
        id: 'trace-1',
        fromID: 'actor-1',
        deleted: false,
        visibility: 'PUBLIC',
      })
      .mockResolvedValueOnce({
        fromID: 'actor-1',
        visibility: 'PRIVATE',
      });
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00Z'),
      user: { id: 'actor-1', nickname: 'Aki' },
      replyTo: null,
    });

    await traceService.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['mention-user-1'],
    });

    expect(prisma.trace.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    expect(
      prisma.$transaction.mock.calls.some(([operations]) =>
        Array.isArray(operations),
      ),
    ).toBe(false);
    expect(push.sendNotification).not.toHaveBeenCalled();
    expect(realtime.broadcastInteractionUnread).not.toHaveBeenCalled();
    expect(realtime.broadcastNotificationCreated).not.toHaveBeenCalled();
    expect(
      realtime.broadcastCirclePostInteractionCreated,
    ).not.toHaveBeenCalled();
  });
});
