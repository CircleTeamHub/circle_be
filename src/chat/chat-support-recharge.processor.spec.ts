import {
  ChatSupportRechargeProcessor,
  classifyRechargeRequest,
} from './chat-support-recharge.processor';

describe('classifyRechargeRequest', () => {
  it.each([
    ['1', 'MEMBERSHIP'],
    ['2', 'COIN'],
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

function textMessageHarness(
  text: string,
  options: {
    activeOrder?: {
      id: string;
      orderNo: string;
      status: 'AWAITING_PROOF' | 'WAITING_REVIEW' | 'PROCESSING';
    } | null;
  } = {},
) {
  const prisma = {
    supportRechargeJob: {
      findUnique: jest.fn().mockResolvedValue({ id: 'job-text' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ sourceMessageID: 'message-text', attempts: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    chatMessage: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'message-text',
        height: 9,
        conversationID: 'conversation-1',
        senderID: 'user-1',
        type: 'text',
        content: { text },
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
      upsert: jest.fn().mockResolvedValue({ mode: 'BOT', lastWelcomeAt: null }),
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
      findFirst: jest.fn().mockResolvedValue(options.activeOrder ?? null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    chatMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const messages = { insertServerMessage: jest.fn().mockResolvedValue({}) };
  const upload = { copyObjectToKey: jest.fn().mockResolvedValue(undefined) };
  const broadcast = { emitRead: jest.fn() };
  const processor = new ChatSupportRechargeProcessor(
    prisma as never,
    messages as never,
    upload as never,
    broadcast as never,
  );
  return { prisma, messages, upload, broadcast, processor };
}

describe('ChatSupportRechargeProcessor payment evidence', () => {
  it('shows the short numbered menu for an unclassified message', async () => {
    const { processor, messages } = textMessageHarness('你好');

    await processor.processMessage('message-text');

    expect(messages.insertServerMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        content: {
          text: '你好，这里是充值服务。请回复数字选择：\n1. 充值会员\n2. 充值积分\n3. 人工客服',
        },
      }),
    );
  });

  it('shows the menu instead of creating an order for a general recharge request', async () => {
    const { processor, prisma, messages } = textMessageHarness('充值');

    await processor.processMessage('message-text');

    expect(messages.insertServerMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        clientMessageId: 'sr-welcome-message-text',
      }),
    );
    expect(prisma.supportRechargePaymentCode.findMany).not.toHaveBeenCalled();
    expect(prisma.supportRechargeOrder.create).not.toHaveBeenCalled();
  });

  it('keeps the conversation unread when option 3 requests a human', async () => {
    const { processor, prisma, messages, broadcast } = textMessageHarness('3');

    await processor.processMessage('message-text');

    expect(prisma.supportRechargeConversationState.update).toHaveBeenCalledWith(
      {
        where: { conversationID: 'conversation-1' },
        data: { mode: 'HUMAN' },
      },
    );
    expect(messages.insertServerMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        content: {
          text: '已转人工客服。请直接说明问题，客服上线后会在本会话回复。',
        },
      }),
    );
    expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
    expect(broadcast.emitRead).not.toHaveBeenCalled();
  });

  it('does not resend the QR while an order is awaiting proof', async () => {
    const { processor, messages, upload } = textMessageHarness('2', {
      activeOrder: {
        id: 'order-open',
        orderNo: 'RC202608290099',
        status: 'AWAITING_PROOF',
      },
    });

    await processor.processMessage('message-text');

    expect(messages.insertServerMessage).toHaveBeenCalledTimes(1);
    expect(messages.insertServerMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        content: {
          text: '充值申请 RC202608290099 正在等待付款截图，请勿重复付款。',
        },
      }),
    );
    expect(upload.copyObjectToKey).not.toHaveBeenCalled();
  });

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
    expect(messages.insertServerMessage).toHaveBeenCalledTimes(2);
    expect(messages.insertServerMessage).toHaveBeenNthCalledWith(
      1,
      'conversation-1',
      expect.objectContaining({
        type: 'text',
        content: {
          text: '充值申请：RC202608290002\n付款方式：当前收款码\n请使用下方收款码付款，勿使用历史二维码。付款后发送转账截图（保留金额、时间和交易编号）。',
        },
      }),
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
