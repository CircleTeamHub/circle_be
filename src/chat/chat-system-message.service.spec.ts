import { ChatSystemMessageService } from './chat-system-message.service';

describe('ChatSystemMessageService', () => {
  const prisma = {
    chatMessage: { aggregate: jest.fn(), create: jest.fn() },
    chatConversation: { update: jest.fn() },
    chatMember: { updateMany: jest.fn() },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  const broadcast = { emitMessage: jest.fn() };
  const push = { onMessageBroadcast: jest.fn().mockResolvedValue(undefined) };

  const service = new ChatSystemMessageService(
    prisma as never,
    broadcast as never,
    push as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
    );
    prisma.$executeRaw.mockResolvedValue(1);
    // G-05:发号走会话行计数器(SELECT..FOR UPDATE),不再做聚合扫描。
    prisma.$queryRaw.mockResolvedValue([{ nextHeight: 7 }]);
    prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 7 } });
    prisma.chatMessage.create.mockResolvedValue({
      id: 'sys-1',
      height: 8,
      createdAt: new Date('2026-08-09T00:00:00Z'),
    });
    prisma.chatConversation.update.mockResolvedValue({});
    prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });
  });

  // 用户 swipe 隐藏了群之后,进/退群提示照常落库并计入未读,但会话本身不回到
  // GET /chat/conversations —— 表现为「有未读却找不到会话」。客户端发送与
  // insertServerMessage 都会清 hiddenAt,只有这条系统消息路径漏了。
  it('unhides the conversation for members who had hidden it', async () => {
    await service.emit('conv-1', { kind: 'member-left' });

    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
  });

  it('advances lastMessageAt and broadcasts the system message', async () => {
    await service.emit('conv-1', { kind: 'member-joined', names: ['甲'] });

    expect(prisma.chatConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv-1' } }),
    );
    expect(broadcast.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', type: 'system' }),
    );
  });
});
