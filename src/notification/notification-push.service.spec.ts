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
  const configValues: Record<string, string | boolean | undefined> = {};
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
  });

  describe('sendToTokens', () => {
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

    it('routes JPush tokens through the JPush API with Basic auth and platform payloads', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app-key';
      configValues.JPUSH_MASTER_SECRET = 'jpush-master-secret';
      configValues.JPUSH_APNS_PRODUCTION = 'true';
      service = new NotificationPushService(prisma as any, config as any);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ sendno: '1', msg_id: 'jpush-message-1' }),
      });

      const outcomes = await service.sendMessages([
        {
          token: '1a0018970a9d4f4f8f1',
          provider: 'jpush',
          platform: 'android',
          projectId: null,
          payload: { ...payload, badge: 7, ttl: 300, threadId: 'thread-1' },
        },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string>; body: string },
      ];
      expect(url).toBe('https://api.jpush.cn/v3/push');
      expect(init.headers.Authorization).toBe(
        `Basic ${Buffer.from('jpush-app-key:jpush-master-secret').toString('base64')}`,
      );
      expect(JSON.parse(init.body)).toEqual(
        expect.objectContaining({
          platform: ['android'],
          audience: { registration_id: ['1a0018970a9d4f4f8f1'] },
          notification: expect.objectContaining({
            alert: 'B',
            android: expect.objectContaining({ title: 'T', alert: 'B' }),
          }),
          options: expect.objectContaining({
            time_to_live: 300,
            apns_production: true,
          }),
        }),
      );
      expect(outcomes).toEqual([
        {
          token: '1a0018970a9d4f4f8f1',
          status: 'SENT',
          receiptFinal: true,
        },
      ]);
    });

    it('accepts the boolean value produced by Joi for JPUSH_APNS_PRODUCTION', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app-key';
      configValues.JPUSH_MASTER_SECRET = 'jpush-master-secret';
      configValues.JPUSH_APNS_PRODUCTION = true;
      service = new NotificationPushService(prisma as any, config as any);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ sendno: '1', msg_id: 'jpush-message-1' }),
      });

      await service.sendMessages([
        {
          token: '1a0018970a9d4f4f8f1',
          provider: 'jpush',
          platform: 'ios',
          projectId: null,
          payload,
        },
      ]);

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { body: string },
      ];
      expect(JSON.parse(init.body).options.apns_production).toBe(true);
    });

    it('keeps JPush deliveries retryable when server credentials are absent', async () => {
      const outcomes = await service.sendMessages([
        {
          token: '1a0018970a9d4f4f8f1',
          provider: 'jpush',
          platform: 'android',
          projectId: null,
          payload,
        },
      ]);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(outcomes).toEqual([
        {
          token: '1a0018970a9d4f4f8f1',
          status: 'RETRYABLE',
          error: 'JPushNotConfigured',
        },
      ]);
    });

    it('keeps JPush authentication failures retryable without disabling tokens', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app-key';
      configValues.JPUSH_MASTER_SECRET = 'expired-secret';
      service = new NotificationPushService(prisma as any, config as any);
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 1004, message: 'auth failed' } }),
      });

      const outcomes = await service.sendMessages([
        {
          token: '1a0018970a9d4f4f8f1',
          provider: 'jpush',
          platform: 'android',
          projectId: null,
          payload,
        },
      ]);

      expect(outcomes).toEqual([
        {
          token: '1a0018970a9d4f4f8f1',
          status: 'RETRYABLE',
          error: 'JPushError:1004',
        },
      ]);
      expect(prisma.devicePushToken.updateMany).not.toHaveBeenCalled();
    });

    it('disables only the individual invalid JPush registration id', async () => {
      configValues.JPUSH_APP_KEY = 'jpush-app-key';
      configValues.JPUSH_MASTER_SECRET = 'jpush-master-secret';
      service = new NotificationPushService(prisma as any, config as any);
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 1003, message: 'invalid regid' } }),
      });

      const outcomes = await service.sendMessages([
        {
          token: '1a0018970a9d4f4f8f1',
          provider: 'jpush',
          platform: 'android',
          projectId: null,
          payload,
        },
      ]);

      expect(outcomes).toEqual([
        {
          token: '1a0018970a9d4f4f8f1',
          status: 'TERMINAL',
          error: 'JPushInvalidRegistrationId',
        },
      ]);
      expect(prisma.devicePushToken.updateMany).toHaveBeenCalledWith({
        where: { token: { in: ['1a0018970a9d4f4f8f1'] } },
        data: { disabledAt: expect.any(Date) },
      });
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
          platform: 'ios',
        })),
        {
          userID: 'u2',
          token: 'u2-0',
          projectId: null,
          provider: 'jpush',
          platform: 'android',
        },
      ]);

      const byUser = await service.listActiveTokensForUsers(['u1', 'u2', 'u3']);

      expect(prisma.devicePushToken.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.devicePushToken.findMany).toHaveBeenCalledWith({
        where: {
          userID: { in: ['u1', 'u2', 'u3'] },
          disabledAt: null,
        },
        select: {
          userID: true,
          token: true,
          projectId: true,
          provider: true,
          platform: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
      expect(byUser.get('u1')).toHaveLength(20);
      expect(byUser.get('u1')?.[0]).toEqual({
        token: 'u1-0',
        projectId: null,
        provider: 'expo',
        platform: 'ios',
      });
      expect(byUser.get('u2')).toEqual([
        {
          token: 'u2-0',
          projectId: null,
          provider: 'jpush',
          platform: 'android',
        },
      ]);
      expect(byUser.has('u3')).toBe(false);
    });

    it('does not query for an empty recipient list', async () => {
      await expect(service.listActiveTokensForUsers([])).resolves.toEqual(
        new Map(),
      );
      expect(prisma.devicePushToken.findMany).not.toHaveBeenCalled();
    });
  });

  describe('sendMessages', () => {
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
