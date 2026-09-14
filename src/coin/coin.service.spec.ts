import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CoinService } from './coin.service';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';

const IDEM = 'idem-key-1';
// 幂等快路径命中时 select 出来的指纹;与 arrangeHealthyGift 那笔转账一致。
const PRIOR_GIFT = {
  senderID: 'sender-1',
  recipientID: 'recipient-1',
  amount: 100,
};

// 卡片签发已从请求路径脱钩(review P1:不能让聊天投递挡住钱的响应),
// 所以断言之前要把这一拍排空。
const flush = () => new Promise((resolve) => setImmediate(resolve));

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
        { provide: ChatService, useValue: chatService },
        { provide: ChatSystemMessageService, useValue: chatMessages },
      ],
    }).compile();

    service = module.get<CoinService>(CoinService);
  });

  it('credits a wallet and its immutable ledger row in the caller transaction', async () => {
    tx.wallet.upsert.mockResolvedValue({ balance: 0 });
    tx.wallet.update.mockResolvedValue({ balance: 20 });
    tx.coinTransaction.create.mockResolvedValue({ id: 'tx-1' });

    await expect(
      service.creditInTransaction(tx as never, {
        userId: 'user-1',
        amount: 20,
        type: 'REFERRAL_REWARD',
        note: '邀请好友奖励',
        relatedId: 'referral-1',
        idempotencyKey: 'referral:inviter:referral-1',
      }),
    ).resolves.toBe(20);

    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { userID: 'user-1' },
      data: { balance: { increment: 20 } },
      select: { balance: true },
    });
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userID: 'user-1',
        type: 'REFERRAL_REWARD',
        amount: 20,
        balance: 20,
        relatedID: 'referral-1',
        idempotencyKey: 'referral:inviter:referral-1',
      }),
    });
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
    prisma.coinGift.findUnique.mockResolvedValue(PRIOR_GIFT);

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
      await flush();

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
      await flush();

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
      await flush();

      // cardDeliveredAt 保持空 —— cron 的查询条件正是它,兜底才捡得到。
      expect(prisma.coinGift.update).not.toHaveBeenCalled();
    });

    it('returns even when the chat dependency never settles (P1)', async () => {
      // 钱已经落库了。发卡要碰聊天库与跨节点 fetchSockets,任何一处卡住都不能
      // 把 POST /coin/gift 的响应一起挂住 —— 代理/客户端超时后付款方不知道钱
      // 到底动没动,回转账页重试会生成新的幂等键,那是第二次真实扣款。
      arrangeHealthyGift();
      chatMessages.insertServerMessage.mockImplementation(
        () => new Promise(() => undefined), // 永不兑现
      );

      await expect(
        service.sendGift('sender-1', 'recipient-1', 100, IDEM),
      ).resolves.toBeUndefined();

      // 钱确实提交了,而且没有被发卡挡住。
      expect(tx.coinGift.create).toHaveBeenCalled();
    });

    it('shares one idempotency key with the compensation cron', async () => {
      // 两条路径同键 → (conversationID, senderID, clientMessageId) 唯一约束
      // 把重复投递合并成一条,收款方永远只看到一张卡。
      arrangeHealthyGift();

      await service.sendGift('sender-1', 'recipient-1', 100, IDEM);
      await flush();

      const [, input] = chatMessages.insertServerMessage.mock.calls[0] as [
        string,
        { clientMessageId: string },
      ];
      expect(input.clientMessageId).toBe(`gift_card_${'gift-1'}`);
    });

    it('does not re-issue a card for a suppressed duplicate gift', async () => {
      // 幂等快路径:这一枚 key 的卡片由原始那次请求(或 cron)负责。
      arrangeHealthyGift();
      prisma.coinGift.findUnique.mockResolvedValue(PRIOR_GIFT);

      await service.sendGift('sender-1', 'recipient-1', 100, IDEM);
      await flush();

      expect(chatMessages.insertServerMessage).not.toHaveBeenCalled();
    });
  });

  // ─── 幂等键归属校验 ───────────────────────────────────────────────────────
  //
  // 键全局唯一但不带 userId 前缀(存量格式不动),所以「命中」不等于「重试」:
  // 别人的 key、同 key 换收款人/金额,静默返回会把一笔没发生的转账报成成功。
  describe('idempotency key ownership', () => {
    const select = { senderID: true, recipientID: true, amount: true };
    const p2002 = Object.assign(new Error('unique violation'), {
      code: 'P2002',
    });

    async function expectIdempotencyConflict(promise: Promise<unknown>) {
      const error = await promise.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        errorCode: 'COIN_IDEMPOTENCY_CONFLICT',
      });
    }

    it('replays silently when the prior gift matches sender, recipient and amount', async () => {
      arrangeHealthyGift();
      prisma.coinGift.findUnique.mockResolvedValue(PRIOR_GIFT);

      await expect(
        service.sendGift('sender-1', 'recipient-1', 100, IDEM),
      ).resolves.toBeUndefined();

      expect(prisma.coinGift.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: IDEM },
        select,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects the same key reused for a different recipient', async () => {
      arrangeHealthyGift();
      prisma.coinGift.findUnique.mockResolvedValue(PRIOR_GIFT);

      await expectIdempotencyConflict(
        service.sendGift('sender-1', 'recipient-2', 100, IDEM),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects the same key reused for a different amount', async () => {
      arrangeHealthyGift();
      prisma.coinGift.findUnique.mockResolvedValue(PRIOR_GIFT);

      await expectIdempotencyConflict(
        service.sendGift('sender-1', 'recipient-1', 250, IDEM),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a key that belongs to another sender', async () => {
      arrangeHealthyGift();
      prisma.coinGift.findUnique.mockResolvedValue(PRIOR_GIFT);

      await expectIdempotencyConflict(
        service.sendGift('sender-2', 'recipient-1', 100, IDEM),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('treats a lost P2002 race as a replay when the winner matches', async () => {
      arrangeHealthyGift();
      // 插入撞唯一键的那一刻,赢家的行已经在库里了。
      prisma.$transaction.mockImplementationOnce(async () => {
        prisma.coinGift.findUnique.mockResolvedValue(PRIOR_GIFT);
        throw p2002;
      });

      await expect(
        service.sendGift('sender-1', 'recipient-1', 100, IDEM),
      ).resolves.toBeUndefined();

      // 快路径一次 + 撞键后回查一次
      expect(prisma.coinGift.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.coinGift.findUnique).toHaveBeenLastCalledWith({
        where: { idempotencyKey: IDEM },
        select,
      });
      await flush();
      expect(chatMessages.insertServerMessage).not.toHaveBeenCalled();
    });

    it('rejects a lost P2002 race whose winner has different params', async () => {
      arrangeHealthyGift();
      prisma.$transaction.mockImplementationOnce(async () => {
        prisma.coinGift.findUnique.mockResolvedValue({
          ...PRIOR_GIFT,
          recipientID: 'recipient-9',
        });
        throw p2002;
      });

      await expectIdempotencyConflict(
        service.sendGift('sender-1', 'recipient-1', 100, IDEM),
      );
    });

    it('rethrows a P2002 that did not come from this idempotency key', async () => {
      // 唯一冲突却查不到这把 key 的行:撞的是别的约束,不能报成幂等成功。
      arrangeHealthyGift();
      prisma.$transaction.mockRejectedValueOnce(p2002);

      await expect(
        service.sendGift('sender-1', 'recipient-1', 100, IDEM),
      ).rejects.toBe(p2002);
    });
  });

  describe('getTransactions', () => {
    it('selects only the user-facing ledger columns', async () => {
      const stored = {
        id: 'tx-1',
        userID: 'user-1',
        type: 'GIFT_SENT',
        amount: -100,
        balance: 900,
        note: null,
        relatedID: 'gift-1',
        idempotencyKey: 'client:user-1:abc',
        createdAt: new Date('2026-09-13T00:00:00.000Z'),
      };
      // Prisma 没给 select 就返回全部标量列;镜像这一点,让断言落在查询本身上。
      const project = (select?: Record<string, boolean>) =>
        select
          ? Object.keys(stored)
              .filter((key) => select[key])
              .reduce((acc, key) => ({ ...acc, [key]: stored[key] }), {})
          : stored;
      prisma.coinTransaction.findMany.mockImplementation(
        async ({ select }: { select?: Record<string, boolean> }) => [
          project(select),
        ],
      );

      const rows = await service.getTransactions('user-1');

      expect(prisma.coinTransaction.findMany).toHaveBeenCalledWith({
        where: { userID: 'user-1' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          amount: true,
          balance: true,
          note: true,
          relatedID: true,
          createdAt: true,
        },
      });
      expect(rows).toEqual([
        {
          id: 'tx-1',
          type: 'GIFT_SENT',
          amount: -100,
          balance: 900,
          note: null,
          relatedID: 'gift-1',
          createdAt: stored.createdAt,
        },
      ]);
      expect(rows[0]).not.toHaveProperty('idempotencyKey');
      expect(rows[0]).not.toHaveProperty('userID');
    });
  });
});

// notifyRecharge 是旧「积分充值到账」通知的残留:充值改为客服审核,由
// SupportRechargeService 发放积分并自行广播到账事件,全仓没有任何调用方。
describe('CoinService dead code', () => {
  it('no longer carries the uncalled notifyRecharge helper', () => {
    expect(
      (CoinService.prototype as unknown as Record<string, unknown>)
        .notifyRecharge,
    ).toBeUndefined();
  });
});
