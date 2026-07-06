import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationPushService } from './notification-push.service';

describe('NotificationPushService', () => {
  const prisma = {
    devicePushToken: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  let service: NotificationPushService;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationPushService(prisma as unknown as PrismaService);
    global.fetch = fetchMock as any;
  });

  it('sends expo push messages with routable notification data', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
      { token: 'ExponentPushToken[two]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }, { status: 'ok' }] }),
    });

    await service.sendNotification('user-1', {
      id: 'n1',
      type: 'TRACE_COMMENT',
      content: 'hello',
      read: false,
      createdAt: '2026-07-05T00:00:00.000Z',
      fromUser: { id: 'u2', nickname: 'Aki', avatarUrl: null },
      fromTrace: { id: 'trace-1', excerpt: 'body', firstImage: null },
      fromReply: { id: 'reply-1', content: 'hello' },
      fromCircle: null,
      fromCirclePost: null,
      fromInvitation: null,
    });

    expect(prisma.devicePushToken.findMany).toHaveBeenCalledWith({
      where: {
        userID: 'user-1',
        provider: 'expo',
        disabledAt: null,
      },
      select: { token: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0]).toEqual(
      expect.objectContaining({
        to: 'ExponentPushToken[one]',
        title: 'Aki',
        body: 'hello',
        data: expect.objectContaining({
          notificationId: 'n1',
          type: 'TRACE_COMMENT',
          traceId: 'trace-1',
          replyId: 'reply-1',
        }),
      }),
    );
  });

  it('disables expo tokens reported as not registered', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[bad]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            status: 'error',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    });

    await service.sendNotification('user-1', {
      id: 'n1',
      type: 'SYSTEM',
      content: 'done',
      read: false,
      createdAt: '2026-07-05T00:00:00.000Z',
      fromUser: null,
      fromTrace: null,
      fromReply: null,
      fromCircle: null,
      fromCirclePost: null,
      fromInvitation: null,
    });

    expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith({
      where: { token: { in: ['ExponentPushToken[bad]'] } },
      data: { disabledAt: expect.any(Date) },
    });
  });

  it('deletes stale active and old disabled push tokens', async () => {
    prisma.devicePushToken.deleteMany.mockResolvedValue({ count: 3 });

    await expect(service.deleteStaleTokens()).resolves.toEqual({ count: 3 });

    expect(prisma.devicePushToken.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { updatedAt: { lt: expect.any(Date) } },
          { disabledAt: { lt: expect.any(Date) } },
        ],
      },
    });
  });
});
