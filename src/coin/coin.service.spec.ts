import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CoinService } from './coin.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationService } from 'src/notification/notification.service';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';

const IDEM = 'idem-key-1';

describe('CoinService', () => {
  let service: CoinService;

  const tx = {
    wallet: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    coinGift: {
      create: jest.fn(),
    },
    coinTransaction: {
      createMany: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
  };

  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    friend: {
      findFirst: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    coinGift: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    coinTransaction: {
      findMany: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(
      async (
        callback: (transaction: typeof tx) => Promise<unknown>,
      ): Promise<unknown> => callback(tx),
    ),
  };

  const realtimeService = {
    broadcastWalletBalanceChanged: jest.fn(),
    broadcastWalletRechargeCompleted: jest.fn(),
    broadcastSystemNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
    safeBroadcastAll: jest.fn((fns: Array<() => void | Promise<void>>) =>
      Promise.allSettled(fns.map((fn) => fn())),
    ),
  };

  const notificationService = {
    createSystemNotification: jest.fn(),
  };

  const chatService = {
    ensureDirectConversationForSettlement: jest.fn(),
  };

  const chatMessages = {
    insertServerMessage: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoinService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationService, useValue: notificationService },
        { provide: ChatService, useValue: chatService },
        { provide: ChatSystemMessageService, useValue: chatMessages },
      ],
    }).compile();

    service = module.get<CoinService>(CoinService);
  });

  it('rejects gifts to missing or inactive recipients', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'BANNED',
    });

    await expect(
      service.sendGift('sender-1', 'recipient-1', 100, IDEM, 'hi'),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.friend.findFirst).not.toHaveBeenCalled();
  });

  it('fails when the sender balance cannot be decremented atomically', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'sender-1',
      friendID: 'recipient-1',
      state: 'ACCEPTED',
    });
    tx.coinTransaction.aggregate.mockResolvedValue({
      _sum: { amount: -100 },
    });
    tx.wallet.upsert
      .mockResolvedValueOnce({
        id: 'wallet-sender',
        userID: 'sender-1',
        balance: 1_000,
      })
      .mockResolvedValueOnce({
        id: 'wallet-recipient',
        userID: 'recipient-1',
        balance: 0,
      });
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 400 });
    tx.wallet.update
      .mockResolvedValueOnce({ balance: 400 })
      .mockResolvedValueOnce({ balance: 600 });
    tx.coinGift.create.mockResolvedValue({ id: 'gift-1' });
    tx.coinTransaction.createMany.mockResolvedValue({ count: 2 });

    await expect(
      service.sendGift('sender-1', 'recipient-1', 600, IDEM, 'happy birthday'),
    ).rejects.toThrow(BadRequestException);

    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.coinGift.create).not.toHaveBeenCalled();
    expect(tx.coinTransaction.createMany).not.toHaveBeenCalled();
  });

  function arrangeHealthyGift() {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'sender-1',
      friendID: 'recipient-1',
      state: 'ACCEPTED',
    });
    prisma.coinGift.findUnique.mockResolvedValue(null);
    tx.coinTransaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    tx.wallet.upsert.mockResolvedValue({ userID: 'x', balance: 0 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 900 });
    tx.wallet.update.mockResolvedValue({ balance: 100 });
    tx.coinGift.create.mockResolvedValue({ id: 'gift-1' });
    tx.coinTransaction.createMany.mockResolvedValue({ count: 2 });
    chatService.ensureDirectConversationForSettlement.mockResolvedValue(
      'conv-1',
    );
    chatMessages.insertServerMessage.mockResolvedValue({ id: 'msg-1' });
    prisma.coinGift.update.mockResolvedValue({ id: 'gift-1' });
  }

  it('sends a gift: debits sender, credits recipient, records gift + 2 txs', async () => {
    arrangeHealthyGift();

    await service.sendGift(
      'sender-1',
      'recipient-1',
      100,
      IDEM,
      'happy birthday',
    );

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userID: 'sender-1', balance: { gte: 100 } },
      data: { balance: { decrement: 100 } },
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { userID: 'recipient-1' },
      data: { balance: { increment: 100 } },
      select: { balance: true },
    });
    expect(tx.coinGift.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: IDEM }),
    });
    expect(tx.coinTransaction.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ type: 'GIFT_SENT', amount: -100 }),
        expect.objectContaining({ type: 'GIFT_RECEIVED', amount: 100 }),
      ],
    });
  });

  it('is idempotent: a reused idempotencyKey does not charge again', async () => {
    arrangeHealthyGift();
    prisma.coinGift.findUnique.mockResolvedValue({ id: 'gift-prior' });

    await service.sendGift('sender-1', 'recipient-1', 100, IDEM, 'retry');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.coinGift.create).not.toHaveBeenCalled();
  });

  it('rejects gifting yourself before any DB work', async () => {
    await expect(
      service.sendGift('sender-1', 'sender-1', 100, IDEM),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a single gift above the per-gift cap', async () => {
    await expect(
      service.sendGift('sender-1', 'recipient-1', 10_001, IDEM),
    ).rejects.toThrow(/more than/i);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a gift to a non-friend', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue(null);

    await expect(
      service.sendGift('sender-1', 'recipient-1', 100, IDEM),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a gift that would exceed the daily limit', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      state: 'ACCEPTED',
    });
    prisma.coinGift.findUnique.mockResolvedValue(null);
    tx.coinTransaction.aggregate.mockResolvedValue({
      _sum: { amount: -49_500 },
    });
    tx.wallet.upsert.mockResolvedValue({ userID: 'x', balance: 100_000 });

    await expect(
      service.sendGift('sender-1', 'recipient-1', 1_000, IDEM),
    ).rejects.toThrow(/daily gift limit/i);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('getWallet upserts so concurrent first access cannot collide', async () => {
    prisma.wallet.upsert.mockResolvedValue({
      id: 'wallet-1',
      userID: 'user-1',
      balance: 0,
    });

    const wallet = await service.getWallet('user-1');

    expect(wallet.balance).toBe(0);
    expect(prisma.wallet.upsert).toHaveBeenCalledWith({
      where: { userID: 'user-1' },
      update: {},
      create: { userID: 'user-1' },
    });
  });

  // ─── 转账卡片:服务端签发 ──────────────────────────────────────────────────
  //
  // 卡片以前由客户端在扣款之后自己发。自研聊天栈把 transfer-card 收进
  // SERVER_MESSAGE_TYPES(客户端能发 = 能凭空捏造「钱已划走」),于是那条路径
  // 变成 100% 被 validateSendPayload 拒的死代码 —— 每一笔转账的卡片都只能等
  // GiftCardOutboxProcessor 的 2 分钟宽限 + 每分钟 cron 补出来。
  // 现在结算提交后就地签发,cron 退回纯兜底。
  describe('transfer card issuance', () => {
    it('issues the card inline once the money is committed', async () => {
      arrangeHealthyGift();

      await service.sendGift('sender-1', 'recipient-1', 100, IDEM, 'happy');

      expect(
        chatService.ensureDirectConversationForSettlement,
      ).toHaveBeenCalledWith('sender-1', 'recipient-1');
      expect(chatMessages.insertServerMessage).toHaveBeenCalledWith('conv-1', {
        senderID: 'sender-1',
        type: 'transfer-card',
        content: { amount: 100, message: 'happy' },
        clientMessageId: 'gift_card_gift-1',
        push: true,
      });
      expect(prisma.coinGift.update).toHaveBeenCalledWith({
        where: { id: 'gift-1' },
        data: { cardDeliveredAt: expect.any(Date) },
      });
    });

    it('issues the card only after the money transaction commits', async () => {
      // 事务里签发的话:回滚掉的转账已经把卡片广播出去了 —— 收款方看到一张
      // 没有对应资金流水的凭证。
      arrangeHealthyGift();
      const order: string[] = [];
      prisma.$transaction.mockImplementationOnce(async (callback: any) => {
        const result = await callback(tx);
        order.push('commit');
        return result;
      });
      chatMessages.insertServerMessage.mockImplementationOnce(async () => {
        order.push('card');
        return { id: 'msg-1' };
      });

      await service.sendGift('sender-1', 'recipient-1', 100, IDEM);

      expect(order).toEqual(['commit', 'card']);
    });

    it('keeps the transfer successful when card issuance fails', async () => {
      // 钱已经划走了。为一张发不出去的凭证把请求判失败,付款方会以为没转成、
      // 回转账页重试 —— 新幂等键 = 第二次真实扣款。失败就留给补偿 cron。
      arrangeHealthyGift();
      chatMessages.insertServerMessage.mockRejectedValueOnce(
        new Error('chat down'),
      );

      await expect(
        service.sendGift('sender-1', 'recipient-1', 100, IDEM),
      ).resolves.toBeUndefined();

      // cardDeliveredAt 保持空 —— cron 的查询条件正是它,兜底才捡得到。
      expect(prisma.coinGift.update).not.toHaveBeenCalled();
    });

    it('shares one idempotency key with the compensation cron', async () => {
      // 两条路径同键 → (conversationID, senderID, clientMessageId) 唯一约束
      // 把重复投递合并成一条,收款方永远只看到一张卡。
      arrangeHealthyGift();

      await service.sendGift('sender-1', 'recipient-1', 100, IDEM);

      const [, input] = chatMessages.insertServerMessage.mock.calls[0] as [
        string,
        { clientMessageId: string },
      ];
      expect(input.clientMessageId).toBe(`gift_card_${'gift-1'}`);
    });

    it('does not re-issue a card for a suppressed duplicate gift', async () => {
      // 幂等快路径:这一枚 key 的卡片由原始那次请求(或 cron)负责。
      arrangeHealthyGift();
      prisma.coinGift.findUnique.mockResolvedValue({ id: 'gift-prior' });

      await service.sendGift('sender-1', 'recipient-1', 100, IDEM);

      expect(chatMessages.insertServerMessage).not.toHaveBeenCalled();
    });
  });
});
