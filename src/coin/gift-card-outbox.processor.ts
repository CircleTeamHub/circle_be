import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';

const GRACE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const BATCH = 50;

/**
 * 转账卡片补偿（#100）。钱在 sendGift 里已强一致落库；卡片此前只靠客户端
 * IM 发送 —— 发卡失败即永久丢失（客户端无法为已结算的转账重发卡，重转会
 * 双花）。现在：客户端发卡成功后回执置位 cardDeliveredAt；创建 ≥2 分钟仍
 * 未置位的礼物由服务端补发同構卡片。补发与客户端卡片在极端竞态下可能各到
 * 一张 —— 语义是「多一张回执」而不是「多一笔钱」，可接受且一次性。
 */
@Injectable()
export class GiftCardOutboxProcessor {
  private readonly logger = new Logger(GiftCardOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openim: OpenimService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async compensate(now: Date = new Date()): Promise<number> {
    const gifts = await this.prisma.coinGift.findMany({
      where: {
        cardDeliveredAt: null,
        cardAttempts: { lt: MAX_ATTEMPTS },
        createdAt: { lt: new Date(now.getTime() - GRACE_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      include: {
        sender: { select: { id: true, nickname: true, avatarUrl: true } },
      },
    });

    let delivered = 0;
    for (const gift of gifts) {
      try {
        await this.openim.sendTransferCardMessage({
          sendID: gift.senderID,
          recvID: gift.recipientID,
          amount: gift.amount,
          message: gift.message ?? null,
          senderNickname: gift.sender?.nickname,
          senderFaceURL: gift.sender?.avatarUrl ?? null,
        });
        await this.prisma.coinGift.update({
          where: { id: gift.id },
          data: { cardDeliveredAt: new Date(), cardAttempts: { increment: 1 } },
        });
        delivered += 1;
        this.logger.log(`compensated transfer card for gift ${gift.id}`);
      } catch (err) {
        await this.prisma.coinGift.update({
          where: { id: gift.id },
          data: { cardAttempts: { increment: 1 } },
        });
        this.logger.warn(
          `transfer card compensation failed for gift ${gift.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return delivered;
  }
}
