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
    const openim = {
      sendTransferCardMessage: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new GiftCardOutboxProcessor(
      prisma as never,
      openim as never,
    );
    return { prisma, openim, processor };
  }

  it('claims the row BEFORE the external send and passes a gift-derived clientMsgID', async () => {
    const { prisma, openim, processor } = buildHarness();

    const delivered = await processor.compensate(now);

    expect(delivered).toBe(1);
    // 抢占：条件 updateMany（cardDeliveredAt 仍空 + attempts 未被别人动过）
    expect(prisma.coinGift.updateMany).toHaveBeenCalledWith({
      where: { id: 'gift-1', cardDeliveredAt: null, cardAttempts: 0 },
      data: { cardAttempts: { increment: 1 } },
    });
    // 抢占调用先于外呼
    const claimOrder = prisma.coinGift.updateMany.mock.invocationCallOrder[0];
    const sendOrder =
      openim.sendTransferCardMessage.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(sendOrder);
    // OpenIM 侧幂等键：重复投递合并成同一条消息
    expect(openim.sendTransferCardMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clientMsgID: 'gift_card_gift-1' }),
    );
    expect(prisma.coinGift.update).toHaveBeenCalledWith({
      where: { id: 'gift-1' },
      data: { cardDeliveredAt: expect.any(Date) },
    });
  });

  it('skips the send entirely when another replica (or the client receipt) wins the claim', async () => {
    const { openim, processor } = buildHarness({ claimCount: 0 });

    const delivered = await processor.compensate(now);

    expect(delivered).toBe(0);
    expect(openim.sendTransferCardMessage).not.toHaveBeenCalled();
  });

  it('logs a permanent-failure error once attempts are exhausted (visible dead-letter)', async () => {
    const { openim, processor } = buildHarness({
      gifts: [{ ...gift, cardAttempts: 59 }], // 本次失败即打满 60
    });
    openim.sendTransferCardMessage.mockRejectedValue(new Error('im down'));
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
