import { GiftCardOutboxProcessor } from './gift-card-outbox.processor';

describe('GiftCardOutboxProcessor (#100 + PR #120 review)', () => {
  const now = new Date('2026-07-21T12:00:00.000Z');
  const gift = {
    id: 'gift-1',
    senderID: 'user-1',
    recipientID: 'user-2',
    amount: 50,
    message: '请喝咖啡',
    cardAttempts: 0,
    sender: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
  };

  function buildHarness({
    gifts = [gift],
    claimCount = 1,
  }: { gifts?: unknown[]; claimCount?: number } = {}) {
    const prisma = {
      coinGift: {
        findMany: jest.fn().mockResolvedValue(gifts),
        updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const chatService = {
      getOrCreateDirectConversation: jest
        .fn()
        .mockResolvedValue({ id: 'conv-1' }),
    };
    const chatMessages = {
      insertServerMessage: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new GiftCardOutboxProcessor(
      prisma as never,
      chatService as never,
      chatMessages as never,
    );
    return { prisma, chatService, chatMessages, processor };
  }

  it('claims the row BEFORE the send and passes a gift-derived clientMessageId', async () => {
    const { prisma, chatService, chatMessages, processor } = buildHarness();

    const delivered = await processor.compensate(now);

    expect(delivered).toBe(1);
    // 抢占：条件 updateMany（cardDeliveredAt 仍空 + attempts 未被别人动过）
    expect(prisma.coinGift.updateMany).toHaveBeenCalledWith({
      where: { id: 'gift-1', cardDeliveredAt: null, cardAttempts: 0 },
      data: { cardAttempts: { increment: 1 } },
    });
    // 抢占调用先于发送
    const claimOrder = prisma.coinGift.updateMany.mock.invocationCallOrder[0];
    const sendOrder =
      chatMessages.insertServerMessage.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(sendOrder);
    // 卡片补进双方 1:1 会话；幂等键使重复投递合并成同一条消息
    expect(chatService.getOrCreateDirectConversation).toHaveBeenCalledWith(
      'user-1',
      'user-2',
    );
    expect(chatMessages.insertServerMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        senderID: 'user-1',
        type: 'transfer-card',
        content: { amount: 50, message: '请喝咖啡' },
        clientMessageId: 'gift_card_gift-1',
        push: true,
      }),
    );
    expect(prisma.coinGift.update).toHaveBeenCalledWith({
      where: { id: 'gift-1' },
      data: { cardDeliveredAt: expect.any(Date) },
    });
  });

  it('skips the send entirely when another replica (or the client receipt) wins the claim', async () => {
    const { chatMessages, processor } = buildHarness({ claimCount: 0 });

    const delivered = await processor.compensate(now);

    expect(delivered).toBe(0);
    expect(chatMessages.insertServerMessage).not.toHaveBeenCalled();
  });

  it('logs a permanent-failure error once attempts are exhausted (visible dead-letter)', async () => {
    const { chatMessages, processor } = buildHarness({
      gifts: [{ ...gift, cardAttempts: 59 }], // 本次失败即打满 60
    });
    chatMessages.insertServerMessage.mockRejectedValue(new Error('db down'));
    const errorSpy = jest
      .spyOn(
        (processor as unknown as { logger: { error: (msg: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);

    const delivered = await processor.compensate(now);

    expect(delivered).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('PERMANENTLY failed'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('gift=gift-1'),
    );
  });
});
