import { ChatCircleSyncService } from './chat-circle-sync.service';

describe('ChatCircleSyncService', () => {
  const prisma = {
    circle: { findUnique: jest.fn() },
    circleMember: { findMany: jest.fn() },
    chatConversation: { findUnique: jest.fn(), create: jest.fn() },
    chatMember: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const broadcast = {
    joinUserToConversation: jest.fn(),
    removeUserFromConversation: jest.fn(),
  };

  const service = new ChatCircleSyncService(
    prisma as never,
    broadcast as never,
  );
  const runTx = async (cb: (tx: typeof prisma) => unknown) => cb(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(runTx as never);
    prisma.chatMember.createMany.mockResolvedValue({ count: 0 });
    prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
    broadcast.joinUserToConversation.mockResolvedValue(undefined);
    broadcast.removeUserFromConversation.mockResolvedValue(undefined);
  });

  it('creates the conversation and seats every ACTIVE member', async () => {
    prisma.circle.findUnique.mockResolvedValue({ id: 'circle-1' });
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
    prisma.circle.findUnique.mockResolvedValue({ id: 'circle-1' });
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
    prisma.circle.findUnique.mockResolvedValue({ id: 'circle-1' });
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
      prisma.circleMember.findMany.mockResolvedValueOnce([
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
  });
});
