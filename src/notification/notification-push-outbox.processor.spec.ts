import { NotificationPushOutboxProcessor } from './notification-push-outbox.processor';

const notification = {
  id: 'notification-1',
  type: 'SYSTEM',
  content: 'hello',
  read: false,
  createdAt: new Date('2026-07-11T00:00:00.000Z'),
  toUserID: 'user-1',
  fromUser: null,
  fromTrace: null,
  fromReply: null,
  fromCircle: null,
  fromCirclePost: null,
  fromInvitation: null,
  fromFriendRequest: null,
};

function buildHarness({
  jobs,
  pendingDeliveries,
  outcomes,
  tokens = [{ token: 'tok-a', projectId: null }],
}: {
  jobs: any[];
  pendingDeliveries: any[];
  outcomes: any[];
  tokens?: Array<{ token: string; projectId: string | null }>;
}) {
  const prisma = {
    notificationPushOutbox: {
      findMany: jest.fn().mockResolvedValue(jobs),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notificationPushDelivery: {
      createMany: jest.fn().mockResolvedValue({ count: tokens.length }),
      findMany: jest.fn().mockResolvedValue(pendingDeliveries),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const push = {
    composeMessage: jest.fn().mockReturnValue({
      title: 'T',
      body: 'B',
      data: { notificationId: 'notification-1' },
    }),
    listActiveTokens: jest.fn().mockResolvedValue(tokens),
    sendToTokens: jest.fn().mockResolvedValue(outcomes),
  };
  const processor = new NotificationPushOutboxProcessor(
    prisma as any,
    push as any,
  );
  return { prisma, push, processor };
}

describe('NotificationPushOutboxProcessor (#88 per-token)', () => {
  it('only sends to pending/failed deliveries — already-delivered tokens are never re-pushed', async () => {
    const { prisma, push, processor } = buildHarness({
      jobs: [
        {
          id: 'job-1',
          notificationID: 'notification-1',
          status: 'FAILED',
          attempts: 1,
          payload: { title: 'T', body: 'B', data: {} },
          notification,
        },
      ],
      // tok-a 已 SENT，不在待投清单里；只剩 tok-b
      pendingDeliveries: [{ id: 'd-b', token: 'tok-b' }],
      outcomes: [{ token: 'tok-b', status: 'SENT', ticketId: 'ticket-b' }],
      tokens: [
        { token: 'tok-a', projectId: null },
        { token: 'tok-b', projectId: null },
      ],
    });

    const processed = await processor.processPending();

    expect(processed).toBe(1);
    // 发送目标只有待投行的 token
    expect(push.sendToTokens).toHaveBeenCalledWith(
      [{ token: 'tok-b', projectId: null }],
      { title: 'T', body: 'B', data: {} },
    );
    // ticket 落到投递行
    expect(prisma.notificationPushDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd-b' },
      data: expect.objectContaining({ status: 'SENT', ticketID: 'ticket-b' }),
    });
    // 快照已存在则不再重新组装
    expect(push.composeMessage).not.toHaveBeenCalled();
  });

  it('composes and snapshots the payload exactly once', async () => {
    const { prisma, push, processor } = buildHarness({
      jobs: [
        {
          id: 'job-1',
          notificationID: 'notification-1',
          status: 'PENDING',
          attempts: 0,
          payload: null,
          notification,
        },
      ],
      pendingDeliveries: [{ id: 'd-a', token: 'tok-a' }],
      outcomes: [{ token: 'tok-a', status: 'SENT', ticketId: 't1' }],
    });

    await processor.processPending();

    expect(push.composeMessage).toHaveBeenCalledTimes(1);
    const snapshotWrite = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]) => input)
      .find((input) => input.data.payload);
    expect(snapshotWrite).toBeDefined();
  });

  it('lazily creates delivery rows for current tokens (idempotent)', async () => {
    const { prisma, processor } = buildHarness({
      jobs: [
        {
          id: 'job-1',
          notificationID: 'notification-1',
          status: 'PENDING',
          attempts: 0,
          payload: { title: 'T', body: 'B', data: {} },
          notification,
        },
      ],
      pendingDeliveries: [{ id: 'd-a', token: 'tok-a' }],
      outcomes: [{ token: 'tok-a', status: 'SENT', ticketId: 't1' }],
    });

    await processor.processPending();

    expect(prisma.notificationPushDelivery.createMany).toHaveBeenCalledWith({
      data: [
        {
          outboxID: 'job-1',
          notificationID: 'notification-1',
          token: 'tok-a',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('marks the outbox FAILED with backoff when any token outcome is retryable', async () => {
    const { prisma, processor } = buildHarness({
      jobs: [
        {
          id: 'job-1',
          notificationID: 'notification-1',
          status: 'PENDING',
          attempts: 0,
          payload: { title: 'T', body: 'B', data: {} },
          notification,
        },
      ],
      pendingDeliveries: [
        { id: 'd-a', token: 'tok-a' },
        { id: 'd-b', token: 'tok-b' },
      ],
      outcomes: [
        { token: 'tok-a', status: 'SENT', ticketId: 't1' },
        { token: 'tok-b', status: 'RETRYABLE', error: 'ExpoServerError' },
      ],
      tokens: [
        { token: 'tok-a', projectId: null },
        { token: 'tok-b', projectId: null },
      ],
    });

    const processed = await processor.processPending();

    expect(processed).toBe(0);
    // tok-a 已 SENT（下一轮不会再收到）
    expect(prisma.notificationPushDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd-a' },
      data: expect.objectContaining({ status: 'SENT' }),
    });
    // tok-b FAILED 待补发
    expect(prisma.notificationPushDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd-b' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    const failWrite = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]) => input)
      .find((input) => input.data.status === 'FAILED');
    expect(failWrite).toBeDefined();
    expect(failWrite.data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('completes immediately when nothing is pending (all delivered/terminal)', async () => {
    const { prisma, push, processor } = buildHarness({
      jobs: [
        {
          id: 'job-1',
          notificationID: 'notification-1',
          status: 'PENDING',
          attempts: 0,
          payload: { title: 'T', body: 'B', data: {} },
          notification,
        },
      ],
      pendingDeliveries: [],
      outcomes: [],
    });

    const processed = await processor.processPending();

    expect(processed).toBe(1);
    expect(push.sendToTokens).not.toHaveBeenCalled();
    const complete = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]) => input)
      .find((input) => input.data.status === 'COMPLETED');
    expect(complete).toBeDefined();
  });

  it('uses the actual claim time for each job in a long batch (lease regression)', async () => {
    jest.useFakeTimers().setSystemTime(Date.parse('2026-07-11T00:00:00.000Z'));
    try {
      const { prisma, push, processor } = buildHarness({
        jobs: [
          {
            id: 'job-1',
            notificationID: 'notification-1',
            status: 'PENDING',
            attempts: 0,
            payload: { title: 'T', body: 'B', data: {} },
            notification,
          },
          {
            id: 'job-2',
            notificationID: 'notification-2',
            status: 'PENDING',
            attempts: 0,
            payload: { title: 'T', body: 'B', data: {} },
            notification,
          },
        ],
        pendingDeliveries: [{ id: 'd-a', token: 'tok-a' }],
        outcomes: [{ token: 'tok-a', status: 'SENT', ticketId: 't1' }],
      });
      push.sendToTokens
        .mockImplementationOnce(async () => {
          jest.setSystemTime(Date.parse('2026-07-11T00:11:00.000Z'));
          return [{ token: 'tok-a', status: 'SENT', ticketId: 't1' }];
        })
        .mockResolvedValueOnce([
          { token: 'tok-a', status: 'SENT', ticketId: 't2' },
        ]);

      await processor.processPending();

      const claims = prisma.notificationPushOutbox.updateMany.mock.calls
        .map(([input]) => input)
        .filter((input) => input.data.status === 'PROCESSING');
      expect(claims).toHaveLength(2);
      expect(claims[0].data.lockedAt).toEqual(
        new Date('2026-07-11T00:00:00.000Z'),
      );
      expect(claims[1].data.lockedAt).toEqual(
        new Date('2026-07-11T00:11:00.000Z'),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
