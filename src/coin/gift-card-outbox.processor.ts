import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { reportOperationalError } from 'src/logging/error-aggregation.service';

const GRACE_MS = 2 * 60 * 1000;
// review 修复：5 次（≈5 分钟）就永久放弃会让一次略长的数据库抖动永久
// 丢卡。60 次 ≈ 1 小时逐分钟重试；clientMessageId 幂等使重复投递无害。
//
// 导出给 metrics/outbox-depth.service：死信行（钱已结算但卡永久丢失）的判定
// 必须和这里同一个数，否则积压指标会和实际放弃行为分叉。
export const GIFT_CARD_MAX_ATTEMPTS = 60;
const MAX_ATTEMPTS = GIFT_CARD_MAX_ATTEMPTS;
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
    private readonly chatService: ChatService,
    private readonly chatMessages: ChatSystemMessageService,
  ) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'gift_card_outbox')
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
      // review 修复（先抢占后外呼）：条件 updateMany 抢到这一分钟的投递权
      // 才发 —— 多副本同时扫表 / 客户端回执竞态时，输家 count=0 直接跳过，
      // 不再出现「发完卡才发现别人已置位」的窗口。attempts 先记账：HTTP
      // 超时但 OpenIM 已收下的情况也算一次尝试。
      const claimed = await this.prisma.coinGift.updateMany({
        where: {
          id: gift.id,
          cardDeliveredAt: null,
          cardAttempts: gift.cardAttempts,
        },
        data: { cardAttempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue;
      try {
        // 走结算专用解析,不过拉黑/陌生人消息那两道闸:那是给用户主动发消息
        // 设的。钱已经划走,收款人有权拿到凭证 —— 宽限期内对方随手一拉黑就让
        // 60 次尝试全部抛错、卡片永久丢失,是把授权检查用在了错误的地方。
        const conversationId =
          await this.chatService.ensureDirectConversationForSettlement(
            gift.senderID,
            gift.recipientID,
          );
        // gift 派生的固定幂等键:重复补偿(超时重试/多副本)在唯一约束上合并,
        // 接收端永远只看到一张卡。
        await this.chatMessages.insertServerMessage(conversationId, {
          senderID: gift.senderID,
          type: 'transfer-card',
          content: { amount: gift.amount, message: gift.message ?? null },
          clientMessageId: `gift_card_${gift.id}`,
          push: true,
        });
        await this.prisma.coinGift.update({
          where: { id: gift.id },
          data: { cardDeliveredAt: new Date() },
        });
        delivered += 1;
        this.logger.log(`compensated transfer card for gift ${gift.id}`);
      } catch (err) {
        const attemptsNow = gift.cardAttempts + 1;
        if (attemptsNow >= MAX_ATTEMPTS) {
          // review 修复（可见失败）：打光后这行会被查询永久排除 —— 用 error
          // 级日志把「卡片永久丢失、需人工对账」暴露出来（钱已结算，重发卡
          // 用同一 clientMsgID 安全：UPDATE "CoinGift" SET "cardAttempts"=0）。
          this.logger.error(
            `transfer card PERMANENTLY failed after ${attemptsNow} attempts ` +
              `gift=${gift.id} sender=${gift.senderID} recipient=${gift.recipientID} amount=${gift.amount}`,
          );
          reportOperationalError(err, {
            component: 'GiftCardOutboxProcessor',
            operation: 'compensate',
            kind: 'permanent_failure',
          });
        } else {
          this.logger.warn(
            `transfer card compensation failed for gift ${gift.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    return delivered;
  }
}
