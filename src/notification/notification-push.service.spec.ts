import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationPushService } from './notification-push.service';

jest.mock('src/logging/error-aggregation.service', () => ({
  reportOperationalError: jest.fn(),
}));

describe('NotificationPushService (#88 per-token delivery)', () => {
  const prisma = {
    devicePushToken: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    notificationPushDelivery: {
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    notificationPushOutbox: {
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((input: any) =>
      Array.isArray(input) ? Promise.all(input) : input(prisma),
    ),
  };

  let service: NotificationPushService;
  const fetchMock = jest.fn();
  const configValues: Record<string, string | undefined> = {};
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(configValues)) delete configValues[key];
    service = new NotificationPushService(
      prisma as unknown as PrismaService,
      config as any,
    );
    global.fetch = fetchMock as any;
    // reconcileCompletedOutboxes 默认无 outbox 需终结（两次分组聚合都空）。
    // 具体用例用 mockResolvedValueOnce 覆盖。
    prisma.notificationPushDelivery.groupBy.mockResolvedValue([]);
  });

  const payload = { title: 'T', body: 'B', data: { notificationId: 'n1' } };

  describe('composeMessage', () => {
    it('builds a routable payload with actor title and data ids', () => {
      const message = service.composeMessage('user-1', {
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
      } as any);

      expect(message.title).toBe('Aki');
      expect(message.body).toBe('hello');
      expect(message.data).toMatchObject({
        notificationId: 'n1',
        type: 'TRACE_COMMENT',
        toUserId: 'user-1',
        traceId: 'trace-1',
        replyId: 'reply-1',
      });
    });

    it('bounds multibyte push previews by UTF-8 bytes', () => {
      const message = service.composeMessage('user-1', {
        id: 'n1',
        type: 'SYSTEM',
        content: '你'.repeat(2000),
      } as any);

      expect(Buffer.byteLength(message.body, 'utf8')).toBeLessThanOrEqual(1024);
      expect(message.body.length).toBeLessThan(2000);
    });
  });

  describe('sendToTokens', () => {
    it('keeps up to twenty active tokens per provider', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app';
      configValues.JPUSH_MASTER_SECRET = 'jpush-secret';
      service = new NotificationPushService(
        prisma as unknown as PrismaService,
        config as any,
      );
      prisma.devicePushToken.findMany.mockResolvedValue([
        ...Array.from({ length: 20 }, (_, index) => ({
          token: `expo-${index}`,
          projectId: null,
          provider: 'expo',
        })),
        ...Array.from({ length: 20 }, (_, index) => ({
          token: `jpush-${index}`,
          projectId: null,
          provider: 'jpush',
        })),
        { token: 'expo-old', projectId: null, provider: 'expo' },
        { token: 'jpush-old', projectId: null, provider: 'jpush' },
      ]);

      await expect(service.listActiveTokens('user-1')).resolves.toHaveLength(
        40,
      );
      expect(prisma.devicePushToken.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.devicePushToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userID: 'user-1',
            provider: { in: ['expo', 'jpush'] },
            disabledAt: null,
          },
        }),
      );
    });

    it('maps tickets per token and keeps SENT ticket ids', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { status: 'ok', id: 'ticket-1' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } },
            { status: 'error', details: { error: 'MessageRateExceeded' } },
          ],
        }),
      });

      const outcomes = await service.sendToTokens(
        [
          { token: 'tok-a', projectId: null },
          { token: 'tok-b', projectId: null },
          { token: 'tok-c', projectId: null },
        ],
        payload,
      );

      expect(outcomes).toEqual([
        { token: 'tok-a', status: 'SENT', ticketId: 'ticket-1' },
        { token: 'tok-b', status: 'TERMINAL', error: 'DeviceNotRegistered' },
        { token: 'tok-c', status: 'RETRYABLE', error: 'MessageRateExceeded' },
      ]);
      // 只有死令牌被停用
      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith({
        where: { token: { in: ['tok-b'] } },
        data: { disabledAt: expect.any(Date) },
      });
    });

    it('does NOT disable tokens on message-level terminal errors (MessageTooBig)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ status: 'error', details: { error: 'MessageTooBig' } }],
        }),
      });

      const outcomes = await service.sendToTokens(
        [{ token: 'tok-a', projectId: null }],
        payload,
      );

      expect(outcomes[0]).toEqual({
        token: 'tok-a',
        status: 'TERMINAL',
        error: 'MessageTooBig',
      });
      expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
    });

    it('treats InvalidCredentials as retryable and never disables the token (P1)', async () => {
      prisma.devicePushToken.updateMany.mockResolvedValue({ count: 0 });
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ status: 'error', details: { error: 'InvalidCredentials' } }],
        }),
      });

      const outcomes = await service.sendToTokens(
        [{ token: 'tok-a', projectId: null }],
        payload,
      );

      // 项目凭据坏了是运维故障：修好后重试应当恢复，token 不能被 reap
      expect(outcomes).toEqual([
        { token: 'tok-a', status: 'RETRYABLE', error: 'InvalidCredentials' },
      ]);
      expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
    });

    it('marks the whole batch retryable when the HTTP call keeps failing', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      const outcomes = await service.sendToTokens(
        [{ token: 'tok-a', projectId: null }],
        payload,
      );

      expect(outcomes[0].status).toBe('RETRYABLE');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('forwards an exhausted Expo send failure to error aggregation', async () => {
      const { reportOperationalError } = jest.requireMock(
        'src/logging/error-aggregation.service',
      ) as { reportOperationalError: jest.Mock };
      reportOperationalError.mockClear();
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      await service.sendToTokens(
        [{ token: 'tok-a', projectId: null }],
        payload,
      );

      expect(reportOperationalError).toHaveBeenCalledWith(expect.any(Error), {
        component: 'NotificationPushService',
        operation: 'sendToTokens',
        kind: 'expo_push',
      });
    });

    it('groups tokens by Expo project id into separate requests', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ status: 'ok', id: 't' }] }),
      });

      await service.sendToTokens(
        [
          { token: 'tok-a', projectId: 'proj-1' },
          { token: 'tok-b', projectId: 'proj-2' },
        ],
        payload,
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sends JPush registration ids without entering the Expo receipt flow', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app';
      configValues.JPUSH_MASTER_SECRET = 'jpush-secret';
      service = new NotificationPushService(
        prisma as unknown as PrismaService,
        config as any,
      );
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ msg_id: 'jpush-message-1' }),
      });

      const outcomes = await service.sendToTokens(
        [{ token: 'registration-1', projectId: null, provider: 'jpush' }],
        payload,
      );

      expect(outcomes).toEqual([
        { token: 'registration-1', status: 'CONFIRMED' },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.jpush.cn/v3/push',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('jpush-app:jpush-secret').toString('base64')}`,
          }),
        }),
      );
      expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
    });

    it('starts Expo delivery without waiting for a slow JPush request', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app';
      configValues.JPUSH_MASTER_SECRET = 'jpush-secret';
      service = new NotificationPushService(
        prisma as unknown as PrismaService,
        config as any,
      );
      let releaseJPush!: () => void;
      const jpushPending = new Promise<void>((resolve) => {
        releaseJPush = resolve;
      });
      fetchMock.mockImplementation((url: string) =>
        url.includes('jpush')
          ? jpushPending.then(() => ({ ok: true, json: async () => ({}) }))
          : Promise.resolve({
              ok: true,
              json: async () => ({
                data: [{ status: 'ok', id: 'expo-ticket' }],
              }),
            }),
      );

      const sending = service.sendToTokens(
        [
          { token: 'jpush-registration', projectId: null, provider: 'jpush' },
          { token: 'ExponentPushToken[expo]', projectId: null },
        ],
        payload,
      );
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('exp.host'),
        expect.anything(),
      );
      releaseJPush();
      await expect(sending).resolves.toHaveLength(2);
    });

    it.each([
      [400, 'TERMINAL'],
      [429, 'RETRYABLE'],
    ] as const)('classifies JPush HTTP %s as %s', async (status, expected) => {
      configValues.JPUSH_APP_KEY = 'jpush-app';
      configValues.JPUSH_MASTER_SECRET = 'jpush-secret';
      service = new NotificationPushService(
        prisma as unknown as PrismaService,
        config as any,
      );
      fetchMock.mockResolvedValue({
        ok: false,
        status,
        json: async () => ({}),
      });

      const outcomes = await service.sendToTokens(
        [{ token: 'jpush-registration', projectId: null, provider: 'jpush' }],
        payload,
      );

      expect(outcomes[0].status).toBe(expected);
    });
  });

  describe('listActiveTokensForUsers', () => {
    it('loads every recipient token in one query and keeps the 20 newest per user', async () => {
      prisma.devicePushToken.findMany.mockResolvedValue([
        ...Array.from({ length: 22 }, (_, i) => ({
          userID: 'u1',
          token: `u1-${i}`,
          projectId: null,
          provider: 'expo',
        })),
        { userID: 'u2', token: 'u2-0', projectId: 'proj', provider: 'expo' },
      ]);

      const byUser = await service.listActiveTokensForUsers(['u1', 'u2', 'u3']);

      expect(prisma.devicePushToken.findMany).toHaveBeenCalledTimes(1);
      // 极光没配凭据:它的 token 不参与投递。
      expect(prisma.devicePushToken.findMany).toHaveBeenCalledWith({
        where: {
          userID: { in: ['u1', 'u2', 'u3'] },
          provider: { in: ['expo'] },
          disabledAt: null,
        },
        select: { userID: true, token: true, projectId: true, provider: true },
        orderBy: { updatedAt: 'desc' },
      });
      expect(byUser.get('u1')).toHaveLength(20);
      expect(byUser.get('u1')?.[0]).toEqual({
        token: 'u1-0',
        projectId: null,
        provider: 'expo',
      });
      expect(byUser.get('u2')).toEqual([
        { token: 'u2-0', projectId: 'proj', provider: 'expo' },
      ]);
      expect(byUser.has('u3')).toBe(false);
    });

    it('also returns JPush devices once JPush is configured, 20 per provider per user', async () => {
      // 聊天扇出走这条批量查询:只查 Expo 的话,极光用户收得到通知推送,却永远收不到聊天推送。
      configValues.JPUSH_APP_KEY = 'jpush-app';
      configValues.JPUSH_MASTER_SECRET = 'jpush-secret';
      service = new NotificationPushService(
        prisma as unknown as PrismaService,
        config as any,
      );
      prisma.devicePushToken.findMany.mockResolvedValue([
        ...Array.from({ length: 21 }, (_, i) => ({
          userID: 'u1',
          token: `expo-${i}`,
          projectId: null,
          provider: 'expo',
        })),
        ...Array.from({ length: 21 }, (_, i) => ({
          userID: 'u1',
          token: `jpush-${i}`,
          projectId: null,
          provider: 'jpush',
        })),
      ]);

      const byUser = await service.listActiveTokensForUsers(['u1']);

      expect(prisma.devicePushToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            provider: { in: ['expo', 'jpush'] },
          }),
        }),
      );
      const tokens = byUser.get('u1') ?? [];
      expect(tokens.filter((t) => t.provider === 'expo')).toHaveLength(20);
      expect(tokens.filter((t) => t.provider === 'jpush')).toHaveLength(20);
    });

    it('does not query for an empty recipient list', async () => {
      await expect(service.listActiveTokensForUsers([])).resolves.toEqual(
        new Map(),
      );
      expect(prisma.devicePushToken.findMany).not.toHaveBeenCalled();
    });
  });

  describe('sendMessages', () => {
    it('delivers mixed Expo and JPush messages and keeps outcomes in input order', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app';
      configValues.JPUSH_MASTER_SECRET = 'jpush-secret';
      service = new NotificationPushService(
        prisma as unknown as PrismaService,
        config as any,
      );
      const jpushBodies: Array<{ audience: { registration_id: string[] } }> =
        [];
      fetchMock.mockImplementation((url: string, init: { body: string }) => {
        if (url.includes('jpush')) {
          jpushBodies.push(JSON.parse(init.body));
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        const body = JSON.parse(init.body) as unknown[];
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: body.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })),
          }),
        });
      });
      const alice = { ...payload, badge: 1 };
      const bob = { ...payload, badge: 2 };

      const outcomes = await service.sendMessages([
        {
          token: 'alice-jpush-1',
          projectId: null,
          provider: 'jpush',
          payload: alice,
        },
        {
          token: 'alice-expo',
          projectId: null,
          provider: 'expo',
          payload: alice,
        },
        {
          token: 'bob-jpush',
          projectId: null,
          provider: 'jpush',
          payload: bob,
        },
        {
          token: 'alice-jpush-2',
          projectId: null,
          provider: 'jpush',
          payload: alice,
        },
      ]);

      expect(outcomes.map((o) => [o.token, o.status])).toEqual([
        ['alice-jpush-1', 'CONFIRMED'],
        ['alice-expo', 'SENT'],
        ['bob-jpush', 'CONFIRMED'],
        ['alice-jpush-2', 'CONFIRMED'],
      ]);
      // 同一份载荷(同一个收件人)共用一个极光请求;角标不同的收件人各发一个。
      const audiences = jpushBodies.map(
        (body) => body.audience.registration_id,
      );
      expect(audiences).toHaveLength(2);
      expect(audiences).toEqual(
        expect.arrayContaining([
          ['alice-jpush-1', 'alice-jpush-2'],
          ['bob-jpush'],
        ]),
      );
    });

    const okForEveryMessage = () =>
      fetchMock.mockImplementation((_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as unknown[];
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: body.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })),
            }),
        });
      });

    // 大群一条消息:原来每个收件人一次 HTTPS 请求,Expo 一次收得下 100 条。
    it('sends up to 100 messages per request, each with its own payload', async () => {
      okForEveryMessage();
      const messages = Array.from({ length: 250 }, (_, i) => ({
        token: `tok-${i}`,
        projectId: null,
        payload: { ...payload, badge: i },
      }));

      const outcomes = await service.sendMessages(messages);

      const bodies = fetchMock.mock.calls.map(
        ([, init]: [string, { body: string }]) =>
          JSON.parse(init.body) as Array<Record<string, unknown>>,
      );
      expect(bodies.map((body) => body.length)).toEqual([100, 100, 50]);
      expect(bodies[2][49]).toEqual(
        expect.objectContaining({ to: 'tok-249', badge: 249, title: 'T' }),
      );
      expect(outcomes).toHaveLength(250);
      expect(outcomes.every((outcome) => outcome.status === 'SENT')).toBe(true);
    });

    it('forwards delivery options into the Expo message only when they are set', async () => {
      okForEveryMessage();

      await service.sendMessages([
        {
          token: 'tok-chat',
          projectId: null,
          payload: {
            ...payload,
            priority: 'high',
            channelId: 'chat',
            tag: 'conv-1',
            threadId: 'conv-1',
            ttl: 300,
          },
        },
        { token: 'tok-plain', projectId: null, payload },
      ]);

      const [chat, plain] = JSON.parse(
        (fetchMock.mock.calls[0][1] as { body: string }).body,
      ) as Array<Record<string, unknown>>;
      expect(chat).toEqual(
        expect.objectContaining({
          to: 'tok-chat',
          priority: 'high',
          channelId: 'chat',
          tag: 'conv-1',
          threadId: 'conv-1',
          ttl: 300,
        }),
      );
      // 系统通知 outbox 不带这些字段,发出去的消息与原来一致。
      for (const key of ['priority', 'channelId', 'tag', 'threadId', 'ttl']) {
        expect(plain).not.toHaveProperty(key);
      }
    });

    it('never mixes Expo projects in one request and still reaps dead tokens', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { status: 'error', details: { error: 'DeviceNotRegistered' } },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ status: 'ok', id: 't' }] }),
        });

      const outcomes = await service.sendMessages([
        { token: 'tok-a', projectId: 'proj-1', payload },
        { token: 'tok-b', projectId: 'proj-2', payload },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(outcomes).toEqual(
        expect.arrayContaining([
          { token: 'tok-a', status: 'TERMINAL', error: 'DeviceNotRegistered' },
          { token: 'tok-b', status: 'SENT', ticketId: 't' },
        ]),
      );
      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith({
        where: { token: { in: ['tok-a'] } },
        data: { disabledAt: expect.any(Date) },
      });
    });
  });

  describe('pollReceipts', () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const sentAt = new Date(now.getTime() - 30 * 60 * 1000);

    it('confirms ok receipts, reaps dead tokens, requeues retryable outboxes', async () => {
      prisma.notificationPushDelivery.findMany.mockResolvedValue([
        { id: 'd1', ticketID: 't1', token: 'tok-a', outboxID: 'o1', sentAt },
        { id: 'd2', ticketID: 't2', token: 'tok-b', outboxID: 'o2', sentAt },
        { id: 'd3', ticketID: 't3', token: 'tok-c', outboxID: 'o3', sentAt },
      ]);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            t1: { status: 'ok' },
            t2: { status: 'error', details: { error: 'DeviceNotRegistered' } },
            t3: { status: 'error', details: { error: 'ExpoServerError' } },
          },
        }),
      });

      const processed = await service.pollReceipts(now);

      expect(processed).toBe(3);
      expect(prisma.notificationPushDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: expect.objectContaining({ status: 'CONFIRMED' }),
      });
      expect(prisma.notificationPushDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd2' },
        data: expect.objectContaining({
          status: 'TERMINAL',
          lastError: 'DeviceNotRegistered',
        }),
      });
      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith({
        where: { token: { in: ['tok-b'] } },
        data: { disabledAt: expect.any(Date) },
      });
      // 可重试错误：投递行 FAILED + outbox 拉回 PENDING 由 sweep 补发
      expect(prisma.notificationPushDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd3' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
      // round 3：requeue 与行状态同事务，形状从批量 in 改为逐条 id
      expect(prisma.notificationPushOutbox.updateMany).toHaveBeenCalledWith({
        where: { id: 'o3', status: 'COMPLETED' },
        data: { status: 'PENDING', nextAttemptAt: now },
      });
    });

    it('marks a completed outbox terminal after its last receipt settles with an exhausted failure', async () => {
      prisma.notificationPushDelivery.findMany.mockResolvedValue([
        { id: 'd1', ticketID: 't1', token: 'tok-a', outboxID: 'o1', sentAt },
      ]);
      // 分组聚合：无 SENT 待回执、有耗尽的 FAILED → 该 outbox 可终结。
      prisma.notificationPushDelivery.groupBy
        .mockResolvedValueOnce([]) // still-awaiting (SENT)
        .mockResolvedValueOnce([{ outboxID: 'o1' }]); // exhausted FAILED
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { t1: { status: 'ok' } } }),
      });

      await service.pollReceipts(now);

      expect(prisma.notificationPushOutbox.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['o1'] }, status: 'COMPLETED' },
        data: {
          status: 'TERMINAL',
          lastError: 'delivery-attempts-exhausted',
        },
      });
    });

    it('reconciles a full batch of distinct outboxes with two grouped queries and one batched update (review P2)', async () => {
      // 回执分散在三个不同 outbox 上 —— 旧实现会为每个 outbox 开一个事务 +
      // 两次 count。断言现在只做两次分组聚合 + 一条批量 updateMany。
      prisma.notificationPushDelivery.findMany.mockResolvedValue([
        { id: 'd1', ticketID: 't1', token: 'tok-a', outboxID: 'o1', sentAt },
        { id: 'd2', ticketID: 't2', token: 'tok-b', outboxID: 'o2', sentAt },
        { id: 'd3', ticketID: 't3', token: 'tok-c', outboxID: 'o3', sentAt },
      ]);
      prisma.notificationPushDelivery.groupBy
        // still-awaiting (SENT)：o2 还有未回执的 SENT
        .mockResolvedValueOnce([{ outboxID: 'o2' }])
        // exhausted FAILED：o1/o2/o3 都有耗尽失败
        .mockResolvedValueOnce([
          { outboxID: 'o1' },
          { outboxID: 'o2' },
          { outboxID: 'o3' },
        ]);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            t1: { status: 'ok' },
            t2: { status: 'ok' },
            t3: { status: 'ok' },
          },
        }),
      });

      await service.pollReceipts(now);

      // 恰好两次分组聚合，不随 outbox 数量线性增长
      expect(prisma.notificationPushDelivery.groupBy).toHaveBeenCalledTimes(2);
      // 一条 updateMany 批量终结 o1/o3；o2 仍有 SENT 被排除
      expect(prisma.notificationPushOutbox.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.notificationPushOutbox.updateMany.mock.calls[0][0];
      expect(call.where.status).toBe('COMPLETED');
      expect([...call.where.id.in].sort((a, b) => a.localeCompare(b))).toEqual([
        'o1',
        'o3',
      ]);
      expect(call.data).toEqual({
        status: 'TERMINAL',
        lastError: 'delivery-attempts-exhausted',
      });
    });

    it('keeps InvalidCredentials receipts retryable without reaping the token (P1)', async () => {
      prisma.notificationPushDelivery.findMany
        .mockResolvedValueOnce([
          { id: 'd1', ticketID: 't1', token: 'tok-a', outboxID: 'o1', sentAt },
        ])
        .mockResolvedValue([]);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            t1: { status: 'error', details: { error: 'InvalidCredentials' } },
          },
        }),
      });

      await service.pollReceipts(now);

      expect(prisma.notificationPushDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: {
          status: 'FAILED',
          receiptCheckedAt: now,
          lastError: 'InvalidCredentials',
        },
      });
      expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
      // outbox 被拉回 PENDING，凭据修好后自动补发
      expect(prisma.notificationPushOutbox.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'COMPLETED' },
        data: { status: 'PENDING', nextAttemptAt: now },
      });
    });

    it('drains multiple batches in one run instead of capping at 300 per 30min', async () => {
      const fullBatch = Array.from({ length: 300 }, (_, index) => ({
        id: `d${index}`,
        ticketID: `t${index}`,
        token: `tok-${index}`,
        outboxID: `o${index}`,
        sentAt,
      }));
      const tail = [
        {
          id: 'd-tail',
          ticketID: 't-tail',
          token: 'tok-t',
          outboxID: 'ot',
          sentAt,
        },
      ];
      prisma.notificationPushDelivery.findMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce(tail)
        .mockResolvedValue([]);
      const okFor = (rows: Array<{ ticketID: string }>) =>
        Object.fromEntries(rows.map((row) => [row.ticketID, { status: 'ok' }]));
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: okFor(fullBatch) }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: okFor(tail) }),
        });

      const processed = await service.pollReceipts(now);

      // 满批 → 继续抽下一批；尾批不足 300 → 收工
      expect(processed).toBe(301);
      expect(prisma.notificationPushDelivery.findMany).toHaveBeenCalledTimes(2);
    });

    it('assumes delivery for receipts older than the 24h Expo retention', async () => {
      const ancient = new Date(now.getTime() - 25 * 60 * 60 * 1000);
      prisma.notificationPushDelivery.findMany.mockResolvedValue([
        {
          id: 'd-old',
          ticketID: 't-old',
          token: 'tok-old',
          outboxID: 'o-old',
          sentAt: ancient,
        },
      ]);

      const processed = await service.pollReceipts(now);

      expect(processed).toBe(1);
      expect(prisma.notificationPushDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['d-old'] } },
        data: expect.objectContaining({ status: 'CONFIRMED' }),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves state untouched when the receipt endpoint is unreachable', async () => {
      prisma.notificationPushDelivery.findMany.mockResolvedValue([
        { id: 'd1', ticketID: 't1', token: 'tok-a', outboxID: 'o1', sentAt },
      ]);
      fetchMock.mockRejectedValue(new Error('down'));

      const processed = await service.pollReceipts(now);

      expect(processed).toBe(0);
      expect(prisma.notificationPushDelivery.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteStaleTokens', () => {
    it('prunes aged tokens under an advisory lock', async () => {
      prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
      prisma.devicePushToken.deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.deleteStaleTokens();

      expect(result.count).toBe(2);
    });

    it('is a no-op when another instance holds the lock', async () => {
      prisma.$queryRaw.mockResolvedValue([{ acquired: false }]);

      const result = await service.deleteStaleTokens();

      expect(result.count).toBe(0);
      expect(prisma.devicePushToken.deleteMany).not.toHaveBeenCalled();
    });
  });
});
