import { ChatBurnSweeperService } from './chat-burn-sweeper.service';

describe('ChatBurnSweeperService', () => {
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    chatConversation: { findMany: jest.fn(), findUnique: jest.fn() },
    chatMessage: { findMany: jest.fn(), updateManyAndReturn: jest.fn() },
  };
  const media = {
    deleteObjects: jest.fn().mockResolvedValue(undefined),
    releaseNoteImportReferences: jest.fn().mockResolvedValue(undefined),
    drainPendingDeletions: jest.fn().mockResolvedValue(undefined),
  };
  const broadcast = {
    emitBurnedMessages: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ChatBurnSweeperService(
    prisma as never,
    media as never,
    broadcast as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    // RETURNING 带回触发器分配的序号:按 id 顺序编号。
    prisma.chatMessage.updateManyAndReturn.mockImplementation(
      (args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id, index) => ({ id, revision: index + 1 })),
        ),
    );
    media.deleteObjects.mockResolvedValue(undefined);
    media.releaseNoteImportReferences.mockResolvedValue(undefined);
    broadcast.emitBurnedMessages.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: 'locked' }]);
    // 每批删除前都重读当前策略(防「扫描中途策略被改长/关掉」)。
    prisma.chatConversation.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          conversationPolicies.get(where.id) ?? { burnDurationSec: null },
        ),
    );
  });

  /** conversationId → findUnique 返回的当前策略。 */
  const conversationPolicies = new Map<
    string,
    { burnDurationSec: number | null; burnStartedAt?: Date | null }
  >();

  // 触发器会去更新会话计数器:先锁一批消息行再等会话行,与「先锁会话行再改消息」
  // 的编辑/回应并发就会交叉死锁。所以批事务的第一条语句必须是会话行锁。
  it('locks the conversation row before tombstoning a batch', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: { text: 'old' } },
    ]);

    await service.sweep();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.chatMessage.updateManyAndReturn.mock.invocationCallOrder[0],
    );
  });

  it('soft-deletes expired rows, clears content and deletes media objects', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 3600 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 3600 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: { text: 'old' } },
      {
        id: 'm2',
        type: 'image',
        content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u1/a.t.jpg' },
      },
    ]);

    await service.sweep();

    const [[query]] = prisma.chatMessage.findMany.mock.calls as [
      [{ where: { createdAt: { lt: Date } } }],
    ];
    // 截止 = 现在 - burnDurationSec,允许极小的执行耗时误差。
    expect(
      Math.abs(Date.now() - 3600_000 - query.where.createdAt.lt.getTime()),
    ).toBeLessThan(5_000);
    // 软删 + 清 content:height 坐标保留,读路径靠 deleted 过滤。
    expect(prisma.chatMessage.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] } },
      // contentHistory 一起清:只清 content 的话,编辑过的旧正文还完整留在库里。
      data: {
        deleted: true,
        deletedAt: expect.any(Date),
        content: {},
        contentHistory: [],
      },
      select: { id: true, revision: true },
    });
    // 只软删不删对象 = 焚毁只焚了个寂寞。
    expect(media.deleteObjects).toHaveBeenCalledWith([
      'chat/u1/a.jpg',
      'chat/u1/a.t.jpg',
    ]);
  });

  it('does nothing when no conversation has burn enabled', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([]);
    await service.sweep();
    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('never tombstones messages from before the current burn activation', async () => {
    const burnStartedAt = new Date('2026-09-14T10:00:00.000Z');
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60, burnStartedAt },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60, burnStartedAt });
    prisma.chatMessage.findMany.mockResolvedValueOnce([]);

    await service.sweep();

    expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: burnStartedAt,
            lt: expect.any(Date),
          },
        }),
      }),
    );
  });

  it('releases shared note-import references instead of deleting them directly', async () => {
    const shared = 'chat/u1/note-import/shared.jpg';
    const owned = 'chat/u1/owned.jpg';
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'image', content: { key: shared, thumbKey: owned } },
    ]);

    await service.sweep();

    expect(media.releaseNoteImportReferences).toHaveBeenCalledWith(
      prisma,
      ['m1'],
      [shared],
    );
    expect(media.deleteObjects).toHaveBeenCalledWith([owned]);
  });

  it('stops the per-conversation loop on a short batch', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: {} },
    ]);

    await service.sweep();
    // 一批就删完(< SWEEP_BATCH):不再发起第二次查询。
    expect(prisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('stops deleting when the burn policy is turned off mid-sweep', async () => {
    // 进入本轮时是 60 秒,但批与批之间用户把焚毁关掉了 —— 拿旧 cutoff 接着删,
    // 删掉的就是用户刚决定要留下的消息,而且不可逆。
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: null });

    await service.sweep();

    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.chatMessage.updateManyAndReturn).not.toHaveBeenCalled();
  });

  // 服务端把正文清空了,在线设备却无从得知 —— 本地缓存、冷启动水合与本地 FTS
  // 仍能端出本该烧掉的内容。每批墓碑提交后告诉在座成员烧掉了哪些 id。
  it('announces the burned ids only after their tombstones commit', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: { text: 'old' } },
      { id: 'm2', type: 'text', content: { text: 'older' } },
    ]);

    await service.sweep();

    expect(broadcast.emitBurnedMessages).toHaveBeenCalledTimes(1);
    expect(broadcast.emitBurnedMessages).toHaveBeenCalledWith('conv-1', [
      { id: 'm1', revision: 1 },
      { id: 'm2', revision: 2 },
    ]);
    expect(
      prisma.chatMessage.updateManyAndReturn.mock.invocationCallOrder[0],
    ).toBeLessThan(broadcast.emitBurnedMessages.mock.invocationCallOrder[0]);
  });

  // 事务回滚了却已经播出去,对端会删掉服务端其实还留着的消息。
  it('announces nothing when the tombstone transaction fails', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: {} },
    ]);
    prisma.$transaction.mockRejectedValueOnce(
      new Error('serialization failure'),
    );

    await service.sweep();

    expect(broadcast.emitBurnedMessages).not.toHaveBeenCalled();
  });

  it('announces nothing when no message has expired', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([]);

    await service.sweep();

    expect(broadcast.emitBurnedMessages).not.toHaveBeenCalled();
  });

  it('announces each committed batch on its own', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    const fullBatch = Array.from({ length: 500 }, (_, i) => ({
      id: `m${i}`,
      type: 'text',
      content: {},
    }));
    prisma.chatMessage.findMany
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([{ id: 'tail', type: 'text', content: {} }]);

    await service.sweep();

    expect(broadcast.emitBurnedMessages).toHaveBeenCalledTimes(2);
    expect(broadcast.emitBurnedMessages).toHaveBeenNthCalledWith(
      1,
      'conv-1',
      fullBatch.map((row, index) => ({ id: row.id, revision: index + 1 })),
    );
    expect(broadcast.emitBurnedMessages).toHaveBeenNthCalledWith(2, 'conv-1', [
      { id: 'tail', revision: 1 },
    ]);
  });

  it('keeps sweeping other conversations when an announcement fails', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
      { id: 'conv-2', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    conversationPolicies.set('conv-2', { burnDurationSec: 60 });
    prisma.chatMessage.findMany
      .mockResolvedValueOnce([{ id: 'm1', type: 'text', content: {} }])
      .mockResolvedValueOnce([{ id: 'm2', type: 'text', content: {} }]);
    broadcast.emitBurnedMessages.mockRejectedValueOnce(
      new Error('adapter down'),
    );

    await service.sweep();

    expect(prisma.chatMessage.updateManyAndReturn).toHaveBeenCalledTimes(2);
    expect(broadcast.emitBurnedMessages).toHaveBeenLastCalledWith('conv-2', [
      { id: 'm2', revision: 1 },
    ]);
  });
});
