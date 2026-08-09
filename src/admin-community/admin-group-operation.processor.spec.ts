import { AdminGroupOperationProcessor } from './admin-group-operation.processor';

describe('AdminGroupOperationProcessor', () => {
  const operation = {
    id: 'operation-1',
    groupID: 'group-1',
    circleID: 'circle-1',
    type: 'MUTE',
    status: 'PROCESSING',
    attempts: 1,
    maxAttempts: 5,
  };
  const prisma = {
    adminGroupOperation: {
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    circle: { update: jest.fn() },
    chatConversation: { updateMany: jest.fn(), findUnique: jest.fn() },
    chatMember: { updateMany: jest.fn() },
    adminAuditLog: { create: jest.fn() },
    $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
      callback(prisma),
    ),
  };
  const chatCircleSync = {
    ensureCircleConversation: jest.fn().mockResolvedValue('conv-1'),
  };
  let processor: AdminGroupOperationProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    chatCircleSync.ensureCircleConversation.mockResolvedValue('conv-1');
    processor = new AdminGroupOperationProcessor(
      prisma as never,
      chatCircleSync as never,
    );
    prisma.adminGroupOperation.updateMany.mockResolvedValue({ count: 1 });
    prisma.chatConversation.updateMany.mockResolvedValue({ count: 1 });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.chatMember.updateMany.mockResolvedValue({ count: 3 });
    prisma.adminGroupOperation.findFirst.mockResolvedValue({
      ...operation,
      status: 'PENDING',
      attempts: 0,
    });
    prisma.adminGroupOperation.findUnique.mockResolvedValue(operation);
  });

  it('mutes the chat conversation and completes circle disabling', async () => {
    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.chatConversation.updateMany).toHaveBeenCalledWith({
      where: { circleID: 'group-1' },
      data: { muteAllAt: expect.any(Date) },
    });
    // 只静音不够:静音只挡发送,且 assertNotMutedAll 对 OWNER/ADMIN 开了口子 ——
    // 停用后群主仍能发言,全体成员仍能拉历史、仍收实时消息。座位必须一并收回
    // (入队时已写 deleted=true,ensureCircleConversation 会清座并踢 socket)。
    expect(chatCircleSync.ensureCircleConversation).toHaveBeenCalledWith(
      'circle-1',
    );
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { adminState: 'DISABLED' },
    });
    expect(prisma.adminGroupOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'operation-1',
        status: 'PROCESSING',
        claimedAt: new Date('2026-07-29T12:00:00.000Z'),
      },
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        lastError: null,
      }),
    });
  });

  it('makes a restored circle visible only after the chat unmute succeeds', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      type: 'UNMUTE',
    });

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.chatConversation.updateMany).toHaveBeenCalledWith({
      where: { circleID: 'group-1' },
      data: { muteAllAt: null },
    });
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: {
        deleted: false,
        adminState: 'ACTIVE',
        adminDisabledAt: null,
        adminDisabledBy: null,
        adminDisableReason: null,
      },
    });
  });

  // 恢复时的重新入座必须发生在 Circle 写回 ACTIVE **之后**。反过来的话,
  // 此刻 adminState 还是 RESTORING、deleted 仍为 true,
  // ensureCircleConversation 只会把刚恢复的圈子再清空一遍。
  it('reseats members only after the circle is written back to ACTIVE', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      type: 'UNMUTE',
    });
    const order: string[] = [];
    prisma.circle.update.mockImplementation(() => {
      order.push('circle-active');
      return Promise.resolve({});
    });
    chatCircleSync.ensureCircleConversation.mockImplementation(() => {
      order.push('reseat');
      return Promise.resolve('conv-1');
    });

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(order).toEqual(['circle-active', 'reseat']);
  });

  // 座位是可对账的派生态:下一次成员变更或有人打开圈聊都会重新收敛。
  // 不该让它把一次已经成功的恢复判成失败再整个重跑。
  it('does not fail a completed unmute when reseating throws', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      type: 'UNMUTE',
    });
    chatCircleSync.ensureCircleConversation.mockRejectedValue(
      new Error('db down'),
    );

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    const failWrite = prisma.adminGroupOperation.updateMany.mock.calls
      .map(([input]: any[]) => input)
      .find((input: any) => input?.data?.status === 'FAILED');
    expect(failWrite).toBeUndefined();
  });

  it('requeues a transient chat-write failure with backoff', async () => {
    prisma.chatConversation.updateMany.mockRejectedValue(
      new Error('db timeout'),
    );

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.adminGroupOperation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'operation-1',
        status: 'PROCESSING',
        claimedAt: new Date('2026-07-29T12:00:00.000Z'),
      },
      data: expect.objectContaining({
        status: 'PENDING',
        lastError: 'db timeout',
        claimedAt: null,
      }),
    });
    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it('marks the operation and circle failed after the final attempt', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      attempts: 5,
      maxAttempts: 5,
    });
    prisma.chatConversation.updateMany.mockRejectedValue(
      new Error('db unavailable'),
    );

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.adminGroupOperation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'operation-1' }),
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { adminState: 'SYNC_FAILED' },
    });
  });

  it('treats dismissing a group with no conversation as idempotent success', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      circleID: null,
      type: 'DISMISS',
    });
    prisma.chatConversation.findUnique.mockResolvedValue(null);

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.adminGroupOperation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'operation-1' }),
      data: expect.objectContaining({ status: 'SUCCEEDED' }),
    });
  });

  it('marks a linked circle permanently dismissed after retiring every seat', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      type: 'DISMISS',
    });

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    // 解散 = 会话全员离座(历史保留;发送被 membership 校验拒绝)。
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', leftAt: null },
      data: { leftAt: expect.any(Date) },
    });
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { deleted: true, adminState: 'DISMISSED' },
    });
  });

  it('does not let a stale worker overwrite an operation reclaimed by another worker', async () => {
    prisma.adminGroupOperation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.chatConversation.updateMany).toHaveBeenCalled();
    expect(prisma.circle.update).not.toHaveBeenCalled();
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });
});
