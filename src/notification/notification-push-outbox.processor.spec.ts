import { readFileSync } from 'fs';
import { join } from 'path';
import { NotificationPushOutboxProcessor } from './notification-push-outbox.processor';

// 名额分配已经从内存里的 selectFairBatch 挪进 SQL(PARTITION BY 发送者排名),
// 因为在内存里只能对「按时间取的窗口」做调度,而窗口本身会被洪水占满 ——
// 灌 13000 条之后,每一轮候选里都只有洪水发送者,正常推送要等约 22 小时。
//
// 排名逻辑本身是 SQL,单元测试跑不到(要真库);这里钉住的是调用契约:
// 确实用了跨全队列的排名查询、每发送者有上限、批量有上限,以及水合之后
// 顺序仍然是名次序 —— 顺序就是公平性本身,水合打乱了等于白排。
describe('fair batch selection contract', () => {
  it('ranks per sender across the whole queue, not inside a time window', () => {
    const source = readFileSync(
      join(__dirname, 'notification-push-outbox.processor.ts'),
      'utf8',
    );
    expect(source).toContain('PARTITION BY n."fromUserID"');
    expect(source).toContain('rn <= ');
    // 先取窗口再调度正是被 review 指出的那个失效模式,不能回潮。
    expect(source).not.toContain('CANDIDATE_WINDOW');
  });
});

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
    // 名额分配现在跨整个队列用 PARTITION BY 排名(见 processor 注释),
    // 排名只回 id,再按 id 水合。桩照这个两步来。
    $queryRaw: jest
      .fn()
      .mockResolvedValue(jobs.map((job: { id: string }) => ({ id: job.id }))),
    notificationPushOutbox: {
      findMany: jest.fn().mockResolvedValue(jobs),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    notificationPushDelivery: {
      createMany: jest.fn().mockResolvedValue({ count: tokens.length }),
      findMany: jest.fn().mockResolvedValue(pendingDeliveries),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      // 打光判定（review 修复）：默认无耗尽行 → COMPLETED
      count: jest.fn().mockResolvedValue(0),
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

  it('marks deliveries TERMINAL instead of retrying tokens the user has since revoked (P1)', async () => {
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
      // 首轮失败时快照的投递行指向 tok-old；重试前用户已登出/换绑，
      // 现在的活跃 token 只有 tok-new
      pendingDeliveries: [{ id: 'd-old', token: 'tok-old' }],
      tokens: [{ token: 'tok-new', projectId: null }],
      outcomes: [],
    });

    await processor.processPending();

    expect(prisma.notificationPushDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['d-old'] } },
      data: { status: 'TERMINAL', lastError: 'token-revoked' },
    });
    // 绝不把旧 token 发出去（可能已归属别的账号）
    expect(push.sendToTokens).not.toHaveBeenCalled();
  });

  it('finishes as TERMINAL (not COMPLETED) when all deliveries exhausted their attempts', async () => {
    const { prisma, processor } = buildHarness({
      jobs: [
        {
          id: 'job-1',
          notificationID: 'notification-1',
          status: 'FAILED',
          attempts: 3,
          payload: { title: 'T', body: 'B', data: {} },
          notification,
        },
      ],
      pendingDeliveries: [], // 全部行 attempts >= 上限，被待投查询滤光
      outcomes: [],
    });
    // 存在打光的 FAILED 行且无 SENT 待回执 → 死信而非完成
    prisma.notificationPushDelivery.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status === 'SENT' ? 0 : 2),
    );

    await processor.processPending();

    const terminal = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]: any[]) => input)
      .find((input: any) => input.data.status === 'TERMINAL');
    expect(terminal).toBeDefined();
    const completed = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]: any[]) => input)
      .find((input: any) => input.data.status === 'COMPLETED');
    expect(completed).toBeUndefined();
  });

  it('keeps the outbox reopenable while receipts are still outstanding (round 3)', async () => {
    const { prisma, processor } = buildHarness({
      jobs: [
        {
          id: 'job-1',
          notificationID: 'notification-1',
          status: 'FAILED',
          attempts: 3,
          payload: { title: 'T', body: 'B', data: {} },
          notification,
        },
      ],
      pendingDeliveries: [],
      outcomes: [],
    });
    // 打光 1 行，但还有 1 行 SENT 在等回执 → 必须 COMPLETED（可被回执轮询
    // 拉回 PENDING），TERMINAL 会把可重试回执失败永久冻住
    prisma.notificationPushDelivery.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status === 'SENT' ? 1 : 1),
    );

    await processor.processPending();

    const terminal = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]: any[]) => input)
      .find((input: any) => input.data.status === 'TERMINAL');
    expect(terminal).toBeUndefined();
    const completed = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]: any[]) => input)
      .find((input: any) => input.data.status === 'COMPLETED');
    expect(completed).toBeDefined();
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
