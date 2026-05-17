import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendState } from 'src/generated/prisma';
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
const MAX_ADMIN_TOPUP = 1_000_000;

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
      throw new BadRequestException('Cannot send coins to yourself');
    }
    if (amount > GIFT_MAX_SINGLE) {
      throw new BadRequestException(
        `Cannot send more than ${GIFT_MAX_SINGLE} coins at once`,
      );
    }

    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, status: true },
    });
    if (!recipient || recipient.status !== 'ACTIVE') {
      throw new NotFoundException('Recipient not found');
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
      throw new ForbiddenException('You can only send coins to friends');
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
          throw new BadRequestException(
            `Daily gift limit of ${GIFT_DAILY_LIMIT} coins reached`,
          );
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
          throw new BadRequestException('Insufficient coins');
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

  // ─── Admin: top-up ────────────────────────────────────────────────────────────

  async adminTopUp(
    targetUserId: string,
    amount: number,
    note?: string,
  ): Promise<WalletDto> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');
    if (amount > MAX_ADMIN_TOPUP) {
      throw new BadRequestException(
        `Amount exceeds the per-top-up cap of ${MAX_ADMIN_TOPUP}`,
      );
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException('User not found');
    }

    const wallet = await runSerializableTransaction(this.prisma, async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { userID: targetUserId },
        update: { balance: { increment: amount } },
        create: { userID: targetUserId, balance: amount },
      });

      await tx.coinTransaction.create({
        data: {
          userID: targetUserId,
          type: 'RECHARGE',
          amount,
          balance: wallet.balance,
          note: note ?? null,
        },
      });

      return wallet;
    });

    await this.notifyRecharge(targetUserId, amount);

    return wallet;
  }

  private async notifyRecharge(userId: string, amount: number): Promise<void> {
    try {
      await this.notificationService.createSystemNotification(
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
      () => this.realtimeService.broadcastSystemNotificationUnread(userId),
    ]);
  }
}
