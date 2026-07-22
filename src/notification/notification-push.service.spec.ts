import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationPushService } from './notification-push.service';

describe('NotificationPushService (#88 per-token delivery)', () => {
  const prisma = {
    devicePushToken: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    notificationPushDelivery: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    notificationPushOutbox: {
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((cb: any) => cb(prisma)),
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
      expect(prisma.notificationPushOutbox.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['o3'] }, status: 'COMPLETED' },
        data: { status: 'PENDING', nextAttemptAt: now },
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
        where: { id: { in: ['o1'] }, status: 'COMPLETED' },
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
