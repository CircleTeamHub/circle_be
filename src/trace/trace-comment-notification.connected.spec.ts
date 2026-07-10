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
      create: jest.fn(),
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
    jest.clearAllMocks();
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
    prisma.notification.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: `notification-${data.toUserID}`,
        ...data,
        content: data.content ?? '',
        read: false,
        createdAt: new Date('2026-07-10T00:00:01Z'),
        fromUser: { id: 'actor-1', nickname: 'Aki', avatarUrl: null },
        fromTrace: { id: 'trace-1', content: 'trace body', images: [] },
        fromReply: { id: 'comment-1', content: 'hello' },
        fromCircle: null,
        fromCirclePost: null,
        fromInvitation: null,
      }),
    );
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

    expect(
      prisma.notification.create.mock.calls.map(([arg]) => arg.data),
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
    const notificationTransaction = prisma.$transaction.mock.calls.find(
      ([operations]) => Array.isArray(operations),
    );
    expect(notificationTransaction?.[0]).toHaveLength(2);
    expect(push.sendNotification).toHaveBeenCalledTimes(2);
    expect(realtime.broadcastNotificationCreated).toHaveBeenCalledTimes(2);
    expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
      'mention-user-1',
      expect.objectContaining({ type: 'TRACE_MENTION' }),
    );
  });

  it('blocks notification, push, and realtime after eligibility is revoked at the boundary', async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'mention-user-1' }])
      .mockResolvedValueOnce([]);

    await expect(
      traceService.addComment('actor-1', 'trace-1', {
        content: 'hello',
        mentionedUserIds: ['mention-user-1'],
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'comment-1' }));

    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.notification.create).not.toHaveBeenCalled();
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
