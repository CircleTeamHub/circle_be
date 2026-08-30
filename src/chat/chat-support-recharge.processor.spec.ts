import {
  ChatSupportRechargeProcessor,
  classifyRechargeRequest,
} from './chat-support-recharge.processor';

describe('classifyRechargeRequest', () => {
  it.each([
    ['我想充值积分', 'COIN'],
    ['购买 VIP', 'MEMBERSHIP'],
    ['收款码发一下', 'GENERAL'],
  ] as const)('classifies %s as %s', (text, expected) => {
    expect(classifyRechargeRequest(text)).toBe(expected);
  });

  it('does not treat unrelated text as a payment instruction', () => {
    expect(classifyRechargeRequest('你好，请问有人吗')).toBeNull();
    expect(classifyRechargeRequest('购买头像框')).toBeNull();
  });
});

describe('ChatSupportRechargeProcessor payment evidence', () => {
  it('moves a screenshot to manual review without granting any benefit', async () => {
    const order = {
      id: 'order-1',
      orderNo: 'RC202608290001',
      conversationID: 'conversation-1',
      userID: 'user-1',
      agentUserID: 'agent-1',
      status: 'AWAITING_PROOF',
    };
    const prisma = {
      supportRechargeJob: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ sourceMessageID: 'message-1', attempts: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      chatMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'message-1',
          height: 7,
          conversationID: 'conversation-1',
          senderID: 'user-1',
          type: 'image',
          content: { key: 'chat/user-1/proof.png' },
          deleted: false,
          revokedAt: null,
          conversation: {
            id: 'conversation-1',
            type: 'DIRECT',
            directKey: 'agent-1:user-1',
          },
        }),
      },
      supportAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'agent' }) },
      supportRechargeConversationState: {
        upsert: jest
          .fn()
          .mockResolvedValue({ mode: 'BOT', lastWelcomeAt: null }),
      },
      supportRechargeOrder: {
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...order, status: 'WAITING_REVIEW' }),
      },
      chatMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const messages = { insertServerMessage: jest.fn().mockResolvedValue({}) };
    const broadcast = { emitRead: jest.fn() };
    const processor = new ChatSupportRechargeProcessor(
      prisma as never,
      messages as never,
      { copyObjectToKey: jest.fn() } as never,
      broadcast as never,
    );

    await processor.processMessage('message-1');

    expect(prisma.supportRechargeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'AWAITING_PROOF' },
      data: expect.objectContaining({
        status: 'WAITING_REVIEW',
        evidenceMessageID: 'message-1',
        evidenceObjectKey: 'chat/user-1/proof.png',
      }),
    });
    expect(messages.insertServerMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        content: expect.objectContaining({
          text: expect.stringContaining('人工核对'),
        }),
      }),
    );
    expect(broadcast.emitRead).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      userId: 'agent-1',
      height: 7,
    });
    expect(prisma.supportRechargeJob.update).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { status: 'COMPLETED', lockedAt: null, lastError: null },
    });
  });

  it('copies the configured QR into a message-specific object before sending', async () => {
    const prisma = {
      supportRechargeJob: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-2' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ sourceMessageID: 'message-2', attempts: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      chatMessage: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'message-2',
          height: 8,
          conversationID: 'conversation-1',
          senderID: 'user-1',
          type: 'text',
          content: { text: '我要充值积分' },
          deleted: false,
          revokedAt: null,
          conversation: {
            id: 'conversation-1',
            type: 'DIRECT',
            directKey: 'agent-1:user-1',
          },
        }),
      },
      supportAgent: { findFirst: jest.fn().mockResolvedValue({ id: 'agent' }) },
      supportRechargeConversationState: {
        upsert: jest
          .fn()
          .mockResolvedValue({ mode: 'BOT', lastWelcomeAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      supportRechargePaymentCode: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'code-1',
            label: '当前收款码',
            objectKey: 'chat/admin-1/master.png',
          },
        ]),
      },
      supportRechargeOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'order-2',
          orderNo: 'RC202608290002',
          status: 'AWAITING_PROOF',
        }),
      },
      chatMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const messages = { insertServerMessage: jest.fn().mockResolvedValue({}) };
    const upload = { copyObjectToKey: jest.fn().mockResolvedValue(undefined) };
    const processor = new ChatSupportRechargeProcessor(
      prisma as never,
      messages as never,
      upload as never,
      { emitRead: jest.fn() } as never,
    );

    await processor.processMessage('message-2');

    expect(upload.copyObjectToKey).toHaveBeenCalledWith(
      'chat/admin-1/master.png',
      'chat/agent-1/message-2-code-1.png',
    );
    expect(messages.insertServerMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        type: 'image',
        content: { key: 'chat/agent-1/message-2-code-1.png' },
      }),
    );
  });
});
