import { ChatBurnSweeperService } from './chat-burn-sweeper.service';

describe('ChatBurnSweeperService', () => {
  const prisma = {
    chatConversation: { findMany: jest.fn() },
    chatMessage: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  const media = { deleteObjects: jest.fn().mockResolvedValue(undefined) };
  const service = new ChatBurnSweeperService(prisma as never, media as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    media.deleteObjects.mockResolvedValue(undefined);
  });

  it('soft-deletes expired rows, clears content and deletes media objects', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 3600 },
    ]);
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
      Math.abs(
        Date.now() - 3600_000 - query.where.createdAt.lt.getTime(),
      ),
    ).toBeLessThan(5_000);
    // 软删 + 清 content:height 坐标保留,读路径靠 deleted 过滤。
    expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] } },
      data: { deleted: true, content: {} },
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
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: {} },
    ]);

    await service.sweep();
    // 一批就删完(< SWEEP_BATCH):不再发起第二次查询。
    expect(prisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
  });
});
