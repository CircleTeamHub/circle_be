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
    // 新座位的已读水位要落在当前最高 height 上,不能是默认 0。
    chatMessage: {
      aggregate: jest.fn().mockResolvedValue({ _max: { height: null } }),
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
        { conversationID: 'conv-1', userID: 'u1', lastReadHeight: 0 },
        { conversationID: 'conv-1', userID: 'u2', lastReadHeight: 0 },
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
        // 复活座位同时把水位推到当前高度:离座期间的消息本就与他无关,
        // 留着旧水位会让重新入群的人一进来就背一堆"未读"。
        data: { leftAt: null, lastReadHeight: 0 },
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

  // 落 schema 默认的 0 的话,新成员一进老群就背着全部历史的未读数(可能几万),
  // 红点永远清不掉 —— 他加入之前的消息本来就不该算他头上。
  it('seats new members at the current message height, not at zero', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.circleMember.findMany.mockResolvedValue([{ userID: 'newcomer' }]);
    prisma.chatMember.findMany.mockResolvedValue([]);
    prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 4321 } });

    await service.ensureCircleConversation('circle-1');

    expect(prisma.chatMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          conversationID: 'conv-1',
          userID: 'newcomer',
          lastReadHeight: 4321,
        },
      ],
      skipDuplicates: true,
    });
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
