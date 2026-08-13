import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CoinTxType, FriendState, Prisma } from 'src/generated/prisma';
import { CoinErrorCode } from 'src/common/app-error-codes';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';
import { CoinTransactionDto, WalletDto } from './dto/coin.dto';

// Max coins a user can send in a single gift
const GIFT_MAX_SINGLE = 10_000;
// Max coins a user can send per day (prevent drain attacks)
const GIFT_DAILY_LIMIT = 50_000;
// Upper bound on a single admin top-up — guards against fat-finger / Int overflow.

@Injectable()
export class CoinService {
  private readonly logger = new Logger(CoinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly notificationService: NotificationService,
    private readonly chatService: ChatService,
    private readonly chatMessages: ChatSystemMessageService,
  ) {}

  // ─── Wallet ───────────────────────────────────────────────────────────────────

  async getWallet(userId: string): Promise<WalletDto> {
    // upsert is race-safe: two concurrent first-access calls can't both
    // insert and trip the `Wallet.userID` unique constraint.
    return this.prisma.wallet.upsert({
      where: { userID: userId },
      update: {},
      create: { userID: userId },
    });
  }

  async getTransactions(userId: string): Promise<CoinTransactionDto[]> {
    return this.prisma.coinTransaction.findMany({
      where: { userID: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Credits an internal, server-authorized reward inside the caller's
   * transaction. Keeping the wallet update and immutable ledger row together
   * prevents a referral from changing the displayed balance without leaving
   * an auditable transaction.
   */
  async creditInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      amount: number;
      type: CoinTxType;
      note: string;
      relatedId: string;
      idempotencyKey: string;
    },
  ): Promise<number> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new Error('Wallet credit amount must be a positive integer');
    }

    await tx.wallet.upsert({
      where: { userID: input.userId },
      update: {},
      create: { userID: input.userId },
    });
    const wallet = await tx.wallet.update({
      where: { userID: input.userId },
      data: { balance: { increment: input.amount } },
      select: { balance: true },
    });
    await tx.coinTransaction.create({
      data: {
        userID: input.userId,
        type: input.type,
        amount: input.amount,
        balance: wallet.balance,
        note: input.note,
        relatedID: input.relatedId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return wallet.balance;
  }

  // ─── Gift ─────────────────────────────────────────────────────────────────────

  async sendGift(
    senderId: string,
    recipientId: string,
    amount: number,
    idempotencyKey: string,
    message?: string,
  ): Promise<void> {
    if (senderId === recipientId) {
      throw new BadRequestException({
        message: 'Cannot send coins to yourself',
        errorCode: CoinErrorCode.SelfTransfer,
      });
    }
    if (amount > GIFT_MAX_SINGLE) {
      throw new BadRequestException({
        message: `Cannot send more than ${GIFT_MAX_SINGLE} coins at once`,
        errorCode: CoinErrorCode.AmountTooLarge,
      });
    }

    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, status: true },
    });
    if (!recipient || recipient.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: 'Recipient not found',
        errorCode: CoinErrorCode.RecipientNotFound,
      });
    }

    // Must be friends
    const friendship = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: senderId, friendID: recipientId },
          { userID: recipientId, friendID: senderId },
        ],
        state: FriendState.ACCEPTED,
      },
    });
    if (!friendship) {
      throw new ForbiddenException({
        message: 'You can only send coins to friends',
        errorCode: CoinErrorCode.NotFriend,
      });
    }

    // Idempotency fast path: if this key was already used, the gift already
    // happened — return success without charging again.
    const priorGift = await this.prisma.coinGift.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    if (priorGift) {
      this.logger.log(`Duplicate gift suppressed (idempotencyKey reused)`);
      return;
    }

    // Execute atomically: deduct sender, credit recipient, create gift record, log txs
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let giftId: string | null = null;
    try {
      giftId = await runSerializableTransaction(this.prisma, async (tx) => {
        const sentToday = await tx.coinTransaction.aggregate({
          where: {
            userID: senderId,
            type: 'GIFT_SENT',
            createdAt: { gte: todayStart },
          },
          _sum: { amount: true },
        });
        const totalSentToday = Math.abs(sentToday._sum.amount ?? 0);
        if (totalSentToday + amount > GIFT_DAILY_LIMIT) {
          throw new BadRequestException({
            message: `Daily gift limit of ${GIFT_DAILY_LIMIT} coins reached`,
            errorCode: CoinErrorCode.DailyLimit,
          });
        }

        // Prisma interactive transactions run on a single connection;
        // issue queries sequentially rather than via Promise.all.
        await tx.wallet.upsert({
          where: { userID: senderId },
          update: {},
          create: { userID: senderId },
        });
        await tx.wallet.upsert({
          where: { userID: recipientId },
          update: {},
          create: { userID: recipientId },
        });

        const debitResult = await tx.wallet.updateMany({
          where: {
            userID: senderId,
            balance: { gte: amount },
          },
          data: { balance: { decrement: amount } },
        });
        if (debitResult.count !== 1) {
          throw new BadRequestException({
            message: 'Insufficient coins',
            errorCode: CoinErrorCode.Insufficient,
          });
        }

        const updatedSender = await tx.wallet.findUniqueOrThrow({
          where: { userID: senderId },
          select: { balance: true },
        });
        const updatedRecipient = await tx.wallet.update({
          where: { userID: recipientId },
          data: { balance: { increment: amount } },
          select: { balance: true },
        });

        const gift = await tx.coinGift.create({
          data: {
            senderID: senderId,
            recipientID: recipientId,
            amount,
            message: message ?? null,
            idempotencyKey,
          },
        });

        await tx.coinTransaction.createMany({
          data: [
            {
              userID: senderId,
              type: 'GIFT_SENT',
              amount: -amount,
              balance: updatedSender.balance,
              note: message ?? null,
              relatedID: gift.id,
            },
            {
              userID: recipientId,
              type: 'GIFT_RECEIVED',
              amount,
              balance: updatedRecipient.balance,
              note: message ?? null,
              relatedID: gift.id,
            },
          ],
        });

        return gift.id;
      });
    } catch (error) {
      // Lost the race against a concurrent request reusing the same key —
      // the unique index rejected the second coinGift insert. The other
      // request already charged; treat this one as an idempotent success.
      if (prismaErrorCode(error) === 'P2002') {
        this.logger.log(
          `Concurrent duplicate gift suppressed (idempotencyKey)`,
        );
        return;
      }
      throw error;
    }

    this.logger.log(
      `Gift sent: ${senderId} → ${recipientId} (${amount} coins)`,
    );

    if (giftId) {
      // **不 await**(review P1)。钱已经落库,这一步只是发凭证 —— 但它要碰聊天库
      // 与跨节点的 fetchSockets,任何一处卡住都会把 POST /coin/gift 的响应一起挂住。
      // catch 只兜「最终 reject」,兜不住「一直不返回」:代理/客户端超时后付款方
      // 不知道钱到底动没动,回转账页重试会生成**新的幂等键** —— 那是第二次真实扣款。
      // 脱钩之后请求在钱提交后立刻返回;卡片照常在毫秒级落地(进程不会取消这个
      // promise),真出故障则由 GiftCardOutboxProcessor 在 2 分钟宽限后接手。
      // issueTransferCard 内部自吞异常,不会产生 unhandled rejection。
      void this.issueTransferCard(giftId, senderId, recipientId, amount, {
        message: message ?? null,
      });
    }
  }

  /**
   * 转账卡片:结算提交之后由服务端就地签发。
   *
   * 为什么不是客户端发:transfer-card 断言的是「钱已经划走」这个服务端事实,
   * 客户端能发就等于能凭空捏造它 —— 所以它在 SERVER_MESSAGE_TYPES 里,
   * 客户端发一律被 validateSendPayload 拒(见 chat.constants.ts 的判据)。
   *
   * 为什么在事务外:insertServerMessage 自带事务并在成功后广播。放进结算事务里
   * 的话,一次回滚就等于把一张没有对应资金流水的凭证广播了出去;而且会把聊天
   * 写入拖进 Serializable 的冲突面,重试连广播一起重放。
   *
   * 为什么失败不抛:钱已经划走了。为一张发不出去的凭证把请求判失败,付款方会以为
   * 没转成、回转账页重试 —— 那是新的幂等键、第二次真实扣款。发不出去就留着
   * cardDeliveredAt 为空,GiftCardOutboxProcessor 在 2 分钟宽限后接手。
   *
   * clientMessageId 与 cron 同键(gift_card_<id>):两条路径撞
   * (conversationID, senderID, clientMessageId) 唯一约束时合并成一条,
   * 收款方永远只看到一张卡 —— cron 因此退化成纯兜底,而不是主路径。
   */
  private async issueTransferCard(
    giftId: string,
    senderId: string,
    recipientId: string,
    amount: number,
    options: { message: string | null },
  ): Promise<void> {
    try {
      // 走结算专用解析,不过拉黑/陌生人消息那两道闸:那是给用户主动发消息设的。
      // 钱已经划走,收款人有权拿到凭证(与补偿 cron 同一判据)。
      const conversationId =
        await this.chatService.ensureDirectConversationForSettlement(
          senderId,
          recipientId,
        );
      await this.chatMessages.insertServerMessage(conversationId, {
        senderID: senderId,
        type: 'transfer-card',
        content: { amount, message: options.message },
        clientMessageId: `gift_card_${giftId}`,
        push: true,
      });
      await this.prisma.coinGift.update({
        where: { id: giftId },
        data: { cardDeliveredAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `inline transfer card failed for gift ${giftId}, leaving it to the compensation cron: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async notifyRecharge(userId: string, amount: number): Promise<void> {
    let notification = null;
    try {
      notification = await this.notificationService.createSystemNotification(
        userId,
        userId,
        `积分已到账 ${amount}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to create recharge notification for ${userId}: ${error instanceof Error ? error.message : error}`,
      );
    }

    await this.realtimeService.safeBroadcastAll([
      () =>
        this.realtimeService.broadcastWalletBalanceChanged(userId, {
          reason: 'RECHARGE',
          delta: amount,
        }),
      () =>
        this.realtimeService.broadcastWalletRechargeCompleted(userId, amount),
      () =>
        this.realtimeService.broadcastSystemNotificationCreated(
          userId,
          `积分已到账 ${amount}`,
        ),
      ...(notification
        ? [
            () =>
              this.realtimeService.broadcastNotificationCreated(
                userId,
                notification,
              ),
          ]
        : []),
      () => this.realtimeService.broadcastSystemNotificationUnread(userId),
    ]);
  }
}
