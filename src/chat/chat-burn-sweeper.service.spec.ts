import { ChatBurnSweeperService } from './chat-burn-sweeper.service';

describe('ChatBurnSweeperService', () => {
  const prisma = {
    chatConversation: { findMany: jest.fn(), findUnique: jest.fn() },
    chatMessage: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  const media = { deleteObjects: jest.fn().mockResolvedValue(undefined) };
  const service = new ChatBurnSweeperService(prisma as never, media as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    media.deleteObjects.mockResolvedValue(undefined);
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
    { burnDurationSec: number | null }
  >();

  it('soft-deletes expired rows, clears content and deletes media objects', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 3600 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 3600 });
    prisma.chatMessage.findMany
      .mockResolvedValueOnce([
        { id: 'm1', type: 'text', content: { text: 'old' } },
        {
          id: 'm2',
          type: 'image',
          content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u1/a.t.jpg' },
        },
      ])
      .mockResolvedValueOnce([]);

    await service.sweep();

    const [[query]] = prisma.chatMessage.findMany.mock.calls as [
      [{ where: { createdAt: { lt: Date } } }],
    ];
    // 截止 = 现在 - burnDurationSec,允许极小的执行耗时误差。
    expect(
      Math.abs(Date.now() - 3600_000 - query.where.createdAt.lt.getTime()),
    ).toBeLessThan(5_000);
    // 软删 + 清 content:height 坐标保留,读路径靠 deleted 过滤。
    expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] } },
      // contentHistory 一起清:只清 content 的话,编辑过的旧正文还完整留在库里。
      data: { deleted: true, content: {}, contentHistory: [] },
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
    expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
  });
});
