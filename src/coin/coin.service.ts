import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendState, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { CoinTransactionDto, WalletDto } from './dto/coin.dto';

// Max coins a user can send in a single gift
const GIFT_MAX_SINGLE = 10_000;
// Max coins a user can send per day (prevent drain attacks)
const GIFT_DAILY_LIMIT = 50_000;
const MAX_GIFT_TX_ATTEMPTS = 3;

@Injectable()
export class CoinService {
  private readonly logger = new Logger(CoinService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Wallet ───────────────────────────────────────────────────────────────────

  async getWallet(userId: string): Promise<WalletDto> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userID: userId } });
    if (!wallet) {
      // Auto-create wallet on first access
      return this.prisma.wallet.create({
        data: { userID: userId },
      });
    }
    return wallet;
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

    // Execute atomically: deduct sender, credit recipient, create gift record, log txs
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    for (let attempt = 1; attempt <= MAX_GIFT_TX_ATTEMPTS; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
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

            await Promise.all([
              tx.wallet.upsert({
                where: { userID: senderId },
                update: {},
                create: { userID: senderId },
              }),
              tx.wallet.upsert({
                where: { userID: recipientId },
                update: {},
                create: { userID: recipientId },
              }),
            ]);

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

            const [updatedSender, updatedRecipient] = await Promise.all([
              tx.wallet.findUniqueOrThrow({
                where: { userID: senderId },
                select: { balance: true },
              }),
              tx.wallet.update({
                where: { userID: recipientId },
                data: { balance: { increment: amount } },
                select: { balance: true },
              }),
            ]);

            const gift = await tx.coinGift.create({
              data: {
                senderID: senderId,
                recipientID: recipientId,
                amount,
                message: message ?? null,
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
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        break;
      } catch (error) {
        if (
          this.isRetryableTransactionError(error) &&
          attempt < MAX_GIFT_TX_ATTEMPTS
        ) {
          this.logger.warn(
            `Retrying gift transaction after serialization conflict (attempt ${attempt})`,
          );
          continue;
        }
        throw error;
      }
    }

    this.logger.log(`Gift sent: ${senderId} → ${recipientId} (${amount} coins)`);
  }

  // ─── Admin: top-up ────────────────────────────────────────────────────────────

  async adminTopUp(targetUserId: string, amount: number, note?: string): Promise<WalletDto> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');

    return this.prisma.$transaction(async (tx) => {
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
  }

  private isRetryableTransactionError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    );
  }
}
