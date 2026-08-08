import { ChatCircleSyncService } from './chat-circle-sync.service';

describe('ChatCircleSyncService', () => {
  const prisma = {
    circle: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    circleMember: { findMany: jest.fn() },
    chatConversation: { findUnique: jest.fn(), create: jest.fn() },
    chatMember: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const broadcast = {
    joinUserToConversation: jest.fn(),
    removeUserFromConversation: jest.fn(),
  };
  const systemMessage = { emit: jest.fn().mockResolvedValue(undefined) };

  const service = new ChatCircleSyncService(
    prisma as never,
    broadcast as never,
    systemMessage as never,
  );
  const runTx = async (cb: (tx: typeof prisma) => unknown) => cb(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(runTx as never);
    prisma.chatMember.createMany.mockResolvedValue({ count: 0 });
    prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
    broadcast.joinUserToConversation.mockResolvedValue(undefined);
    broadcast.removeUserFromConversation.mockResolvedValue(undefined);
    systemMessage.emit.mockResolvedValue(undefined);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
  });

  it('default-denies a dismissed circle and clears every seat', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'DISMISSED',
    });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u1' },
      { userID: 'u2' },
    ]);

    const id = await service.ensureCircleConversation('circle-1');

    expect(id).toBeNull();
    // 照常对账的话,这一轮会把 DISMISS 时设的 leftAt 清回去,群聊自己重新开门。
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', leftAt: null },
      data: { leftAt: expect.any(Date) },
    });
    expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('default-denies a soft-deleted circle', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: true,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue(null);

    await expect(
      service.ensureCircleConversation('circle-1'),
    ).resolves.toBeNull();
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('creates the conversation and seats every ACTIVE member', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue(null);
    prisma.chatConversation.create.mockResolvedValue({ id: 'conv-1' });
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'u1' },
      { userID: 'u2' },
    ]);
    prisma.chatMember.findMany.mockResolvedValue([]);

    const id = await service.ensureCircleConversation('circle-1');

    expect(id).toBe('conv-1');
    expect(prisma.chatConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { type: 'GROUP', circleID: 'circle-1' },
      }),
    );
    expect(prisma.chatMember.createMany).toHaveBeenCalledWith({
      data: [
        { conversationID: 'conv-1', userID: 'u1' },
        { conversationID: 'conv-1', userID: 'u2' },
      ],
      skipDuplicates: true,
    });
    // 新入座成员的在线 socket 被拉入会话房。
    expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'u2',
      'conv-1',
    );
  });

  it('revives left seats and retires seats of members no longer active', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.circleMember.findMany.mockResolvedValue([{ userID: 'u1' }]);
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u1', leftAt: new Date() }, // 重新入圈:复活
      { userID: 'u2', leftAt: null }, // 已被踢:离座
    ]);

    await service.ensureCircleConversation('circle-1');

    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userID: { in: ['u1'] },
          leftAt: { not: null },
        }),
        data: { leftAt: null },
      }),
    );
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userID: { notIn: ['u1'] },
          leftAt: null,
        }),
        data: { leftAt: expect.any(Date) },
      }),
    );
    expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
      'u2',
      'conv-1',
    );
  });

  it('is a no-op returning null for a missing circle', async () => {
    prisma.circle.findUnique.mockResolvedValue(null);
    await expect(service.ensureCircleConversation('gone')).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recovers from a concurrent conversation create via unique refetch', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'conv-1' });
    prisma.chatConversation.create.mockRejectedValue({ code: 'P2002' });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.chatMember.findMany.mockResolvedValue([]);

    await expect(service.ensureCircleConversation('circle-1')).resolves.toBe(
      'conv-1',
    );
  });

  describe('reconcileRecent', () => {
    it('re-syncs each recently changed circle and isolates failures', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { circleID: 'c-bad' },
        { circleID: 'c-good' },
      ]);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('conv-good');

      await service.reconcileRecent();

      expect(ensure).toHaveBeenCalledTimes(2);
      expect(ensure).toHaveBeenNthCalledWith(1, 'c-bad');
      expect(ensure).toHaveBeenNthCalledWith(2, 'c-good');
      ensure.mockRestore();
    });

    it('keeps retrying a circle that failed, even after it ages out of the window', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ circleID: 'c-bad' }]);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockRejectedValueOnce(new Error('boom'));
      await service.reconcileRecent();

      // 下一轮窗口里已经没有这个圈子了(变更时间过期),但它必须继续重试 ——
      // 否则被踢的成员会无限期保留座位。
      prisma.$queryRaw.mockResolvedValueOnce([]);
      ensure.mockResolvedValueOnce('conv-bad');
      await service.reconcileRecent();
      expect(ensure).toHaveBeenNthCalledWith(2, 'c-bad');

      // 成功之后就不再重试。
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.reconcileRecent();
      expect(ensure).toHaveBeenCalledTimes(2);
      ensure.mockRestore();
    });

    it('scans without a row cap that could silently drop circles', async () => {
      const many = Array.from({ length: 500 }, (_, i) => ({
        circleID: `c-${i}`,
      }));
      prisma.$queryRaw.mockResolvedValueOnce(many);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockResolvedValue('conv');

      await service.reconcileRecent();
      // 旧实现 take:200 会把后 300 个圈子直接丢掉且再也选不中。
      expect(ensure).toHaveBeenCalledTimes(500);
      ensure.mockRestore();
    });
  });
});
