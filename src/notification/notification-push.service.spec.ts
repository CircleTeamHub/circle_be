import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationType } from 'src/generated/prisma';
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
  const configValues: Record<string, string | undefined> = {};
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  };

  const buildService = () =>
    new NotificationPushService(
      prisma as unknown as PrismaService,
      config as any,
    );

  const baseNotification = () => ({
    id: 'n1',
    type: 'SYSTEM' as const,
    content: 'hi',
    read: false,
    createdAt: '2026-07-05T00:00:00.000Z',
    fromUser: null,
    fromTrace: null,
    fromReply: null,
    fromCircle: null,
    fromCirclePost: null,
    fromInvitation: null,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(configValues)) delete configValues[key];
    service = buildService();
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
          fromUserId: 'u2',
          fromUserNickname: 'Aki',
          traceId: 'trace-1',
          replyId: 'reply-1',
        }),
      }),
    );
  });

  it('includes canonical actor fields for profile-like pushes', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await service.sendNotification('user-1', {
      ...baseNotification(),
      type: 'PROFILE_LIKE',
      content: '',
      fromUser: { id: 'actor-1', nickname: 'Aki', avatarUrl: null },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0]).toEqual(
      expect.objectContaining({
        title: 'Aki',
        body: '赞了你的资料',
        data: expect.objectContaining({
          type: 'PROFILE_LIKE',
          fromUserId: 'actor-1',
          fromUserNickname: 'Aki',
        }),
      }),
    );
  });

  it('keeps the canonical actor nickname field when the stored nickname is empty', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await service.sendNotification('user-1', {
      ...baseNotification(),
      type: 'PROFILE_LIKE',
      fromUser: { id: 'actor-1', nickname: '', avatarUrl: null },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].data).toEqual(
      expect.objectContaining({
        fromUserId: 'actor-1',
        fromUserNickname: '',
      }),
    );
  });

  it('uses mention fallback text and preserves actor/comment routing fields', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await service.sendNotification('user-1', {
      ...baseNotification(),
      type: NotificationType.TRACE_MENTION,
      content: '',
      fromUser: { id: 'actor-1', nickname: 'Aki', avatarUrl: null },
      fromTrace: {
        id: 'trace-1',
        excerpt: 'original trace must not become the mention body',
        firstImage: null,
      },
      fromReply: { id: 'comment-1', content: '' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0]).toEqual(
      expect.objectContaining({
        body: '在动态评论中提到了你',
        data: expect.objectContaining({
          type: 'TRACE_MENTION',
          fromUserId: 'actor-1',
          fromUserNickname: 'Aki',
          traceId: 'trace-1',
          replyId: 'comment-1',
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

  it('omits the Authorization header when no Expo access token is configured', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await service.sendNotification('user-1', baseNotification());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('attaches a Bearer token when EXPO_ACCESS_TOKEN is configured', async () => {
    configValues.EXPO_ACCESS_TOKEN = 'secret-expo-token';
    service = buildService();
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await service.sendNotification('user-1', baseNotification());

    expect(fetchMock.mock.calls[0][1].headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer secret-expo-token' }),
    );
  });

  it('sends each Expo batch with a bounded request timeout', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
    ]);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    });

    await service.sendNotification('user-1', {
      id: 'n1',
      type: 'SYSTEM',
      content: 'hi',
      read: false,
      createdAt: '2026-07-05T00:00:00.000Z',
      fromUser: null,
      fromTrace: null,
      fromReply: null,
      fromCircle: null,
      fromCirclePost: null,
      fromInvitation: null,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('stays best-effort when the Expo endpoint fails or times out', async () => {
    prisma.devicePushToken.findMany.mockResolvedValue([
      { token: 'ExponentPushToken[one]' },
    ]);
    // Simulate an AbortSignal.timeout firing / network failure.
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      }),
    );

    await expect(
      service.sendNotification('user-1', {
        id: 'n1',
        type: 'SYSTEM',
        content: 'hi',
        read: false,
        createdAt: '2026-07-05T00:00:00.000Z',
        fromUser: null,
        fromTrace: null,
        fromReply: null,
        fromCircle: null,
        fromCirclePost: null,
        fromInvitation: null,
      }),
    ).resolves.toBeUndefined();

    // A failed send must never try to disable tokens on incomplete data.
    expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
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
