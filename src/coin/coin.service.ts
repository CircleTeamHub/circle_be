import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendState } from 'src/generated/prisma';
import { CoinErrorCode } from 'src/common/app-error-codes';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
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

    try {
      await runSerializableTransaction(this.prisma, async (tx) => {
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
  }

/**
   * 客户端 IM 发卡成功回执（#100）：置位 cardDeliveredAt，补偿 cron 不再
   * 补发。按 idempotencyKey 定位（客户端本就持有它；sendGift 响应无 id）。
   * 幂等；仅发送方本人可回执。找不到礼物静默成功 —— 回执迟到于清理属可容忍。
   */
  async markGiftCardSent(
    senderId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.prisma.coinGift.updateMany({
      where: {
        idempotencyKey,
        senderID: senderId,
        cardDeliveredAt: null,
      },
      data: { cardDeliveredAt: new Date() },
    });
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
