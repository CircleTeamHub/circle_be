import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { TrackedCron } from 'src/metrics/tracked-cron.decorator';
import type {
  ChatMessage,
  SupportRechargeOrder,
  SupportRechargeRequestKind,
} from 'src/generated/prisma';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatSystemMessageService } from './chat-system-message.service';
import { UploadService } from 'src/upload/upload.service';

const JOB_BATCH = 20;
const JOB_MAX_ATTEMPTS = 5;
const JOB_STALE_MS = 2 * 60_000;
const JOB_BACKOFF_BASE_MS = 2_000;
const WELCOME_COOLDOWN_MS = 24 * 60 * 60_000;

const REQUEST_KEYWORDS: ReadonlyArray<{
  kind: SupportRechargeRequestKind;
  words: readonly string[];
}> = [
  { kind: 'COIN', words: ['积分', '元宝', '金币'] },
  { kind: 'MEMBERSHIP', words: ['会员', 'vip'] },
  { kind: 'GENERAL', words: ['充值', '付款', '收款码'] },
];

export function classifyRechargeRequest(
  text: string,
): SupportRechargeRequestKind | null {
  const normalized = text.trim().toLocaleLowerCase();
  if (!normalized) return null;
  if (normalized === '1') return 'MEMBERSHIP';
  if (normalized === '2') return 'COIN';
  return (
    REQUEST_KEYWORDS.find(({ words }) =>
      words.some((word) => normalized.includes(word)),
    )?.kind ?? null
  );
}

function asksForHuman(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase();
  if (normalized === '3') return true;
  return ['人工', '真人客服', '转人工'].some((word) =>
    normalized.includes(word),
  );
}

function resumesAutomation(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase();
  return ['重新开始', '自动服务'].some((word) => normalized.includes(word));
}

function messageText(message: Pick<ChatMessage, 'content'>): string {
  const content = message.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return '';
  }
  const text = (content as Record<string, unknown>).text;
  return typeof text === 'string' ? text : '';
}

function messageObjectKey(
  message: Pick<ChatMessage, 'content'>,
): string | null {
  const content = message.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return null;
  }
  const key = (content as Record<string, unknown>).key;
  return typeof key === 'string' && key.startsWith('chat/') ? key : null;
}

function orderNo(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).split('-').join('');
  return `RC${day}${randomUUID().split('-').join('').slice(0, 8).toUpperCase()}`;
}

type IncomingMessage = ChatMessage & {
  conversation: { id: string; type: string; directKey: string | null };
};

/**
 * 充值客服 durable inbox 消费者。
 *
 * - ChatService 与原消息同事务写 job；本服务只在提交后消费。
 * - 每一段自动回复都使用确定性的 clientMessageId，任务重试不会重复发消息。
 * - 图片证据只把订单推进 WAITING_REVIEW，绝不在这里发积分或开会员。
 */
@Injectable()
export class ChatSupportRechargeProcessor {
  private readonly logger = new Logger(ChatSupportRechargeProcessor.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: ChatSystemMessageService,
    private readonly upload: UploadService,
    private readonly broadcast: ChatBroadcastService,
  ) {}

  /** WebSocket 提交后走这条，尽量即时回复；失败由持久化任务的定时扫描补偿。 */
  async processMessage(sourceMessageID: string): Promise<void> {
    const job = await this.prisma.supportRechargeJob.findUnique({
      where: { sourceMessageID },
      select: { id: true },
    });
    if (job) await this.processJob(job.id);
  }

  @TrackedCron(CronExpression.EVERY_MINUTE, 'support_recharge_jobs')
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = new Date();
      await this.prisma.supportRechargeJob.updateMany({
        where: {
          status: 'PROCESSING',
          lockedAt: { lt: new Date(now.getTime() - JOB_STALE_MS) },
        },
        data: { status: 'PENDING', lockedAt: null, nextAttemptAt: now },
      });
      const due = await this.prisma.supportRechargeJob.findMany({
        where: {
          status: 'PENDING',
          attempts: { lt: JOB_MAX_ATTEMPTS },
          nextAttemptAt: { lte: now },
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        take: JOB_BATCH,
        select: { id: true },
      });
      for (const job of due) await this.processJob(job.id);
    } finally {
      this.sweeping = false;
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const lockedAt = new Date();
    const claimed = await this.prisma.supportRechargeJob.updateMany({
      where: { id: jobId, status: 'PENDING', nextAttemptAt: { lte: lockedAt } },
      data: { status: 'PROCESSING', lockedAt, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;

    const job = await this.prisma.supportRechargeJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { sourceMessageID: true, attempts: true },
    });
    try {
      await this.handleIncoming(job.sourceMessageID);
      await this.prisma.supportRechargeJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          lockedAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const terminal = job.attempts >= JOB_MAX_ATTEMPTS;
      const delay = Math.min(
        JOB_BACKOFF_BASE_MS * 2 ** Math.max(0, job.attempts - 1),
        60_000,
      );
      await this.prisma.supportRechargeJob.update({
        where: { id: jobId },
        data: {
          status: terminal ? 'FAILED' : 'PENDING',
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + delay),
          lastError: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 500),
        },
      });
      const detail = `support recharge job=${jobId} attempt=${job.attempts}`;
      if (terminal) this.logger.error(`${detail} dead-lettered`);
      else this.logger.warn(`${detail} will retry`);
    }
  }

  private async handleIncoming(sourceMessageID: string): Promise<void> {
    const source = await this.prisma.chatMessage.findUnique({
      where: { id: sourceMessageID },
      include: {
        conversation: { select: { id: true, type: true, directKey: true } },
      },
    });
    if (!source?.senderID || source.deleted || source.revokedAt) return;
    const message = source as IncomingMessage;
    const agentUserID = message.conversation.directKey
      ?.split(':')
      .find((id) => id !== message.senderID);
    if (!agentUserID || message.conversation.type !== 'DIRECT') return;

    const activeAgent = await this.prisma.supportAgent.findFirst({
      where: {
        category: 'recharge',
        userID: agentUserID,
        enabled: true,
        user: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!activeAgent) return;

    const state = await this.prisma.supportRechargeConversationState.upsert({
      where: { conversationID: message.conversationID },
      update: { userID: message.senderID, agentUserID },
      create: {
        conversationID: message.conversationID,
        userID: message.senderID,
        agentUserID,
      },
    });

    if (message.type === 'image') {
      await this.acceptPaymentEvidence(message, agentUserID);
      await this.markHandledRead(message, agentUserID);
      return;
    }
    if (message.type !== 'text' && message.type !== 'quote') return;

    const text = messageText(message);
    if (resumesAutomation(text)) {
      await this.prisma.supportRechargeConversationState.update({
        where: { conversationID: message.conversationID },
        data: { mode: 'BOT' },
      });
    } else if (asksForHuman(text)) {
      await this.messages.insertServerMessage(message.conversationID, {
        senderID: agentUserID,
        type: 'text',
        content: {
          text: '已转人工客服。请直接说明问题，客服上线后会在本会话回复。',
        },
        clientMessageId: `sr-human-${message.id}`,
        push: true,
      });
      await this.prisma.supportRechargeConversationState.update({
        where: { conversationID: message.conversationID },
        data: { mode: 'HUMAN' },
      });
      // 原消息已经走正常聊天推送；不要替真人客服标记已读，让会话保留未读提醒。
      return;
    } else if (state.mode === 'HUMAN') {
      return;
    }

    const kind = classifyRechargeRequest(text);
    if (!kind) {
      const welcomedRecently =
        state.lastWelcomeAt !== null &&
        Date.now() - state.lastWelcomeAt.getTime() < WELCOME_COOLDOWN_MS;
      if (welcomedRecently) return;
      await this.sendWelcome(message, agentUserID);
      await this.prisma.supportRechargeConversationState.update({
        where: { conversationID: message.conversationID },
        data: { lastWelcomeAt: new Date() },
      });
      await this.markHandledRead(message, agentUserID);
      return;
    }

    await this.startRecharge(message, agentUserID, kind);
    await this.markHandledRead(message, agentUserID);
  }

  private async markHandledRead(
    message: IncomingMessage,
    agentUserID: string,
  ): Promise<void> {
    const updated = await this.prisma.chatMember.updateMany({
      where: {
        conversationID: message.conversationID,
        userID: agentUserID,
        leftAt: null,
        lastReadHeight: { lt: message.height },
      },
      data: { lastReadHeight: message.height },
    });
    if (updated.count > 0) {
      this.broadcast.emitRead({
        conversationId: message.conversationID,
        userId: agentUserID,
        height: message.height,
      });
    }
  }

  private async sendWelcome(
    message: IncomingMessage,
    agentUserID: string,
  ): Promise<void> {
    await this.messages.insertServerMessage(message.conversationID, {
      senderID: agentUserID,
      type: 'text',
      content: {
        text: '你好，这里是充值服务。请回复数字选择：\n1. 充值会员\n2. 充值积分\n3. 人工客服',
      },
      clientMessageId: `sr-welcome-${message.id}`,
      push: true,
    });
  }

  private async startRecharge(
    message: IncomingMessage,
    agentUserID: string,
    requestKind: SupportRechargeRequestKind,
  ): Promise<void> {
    const now = new Date();
    const codes = await this.prisma.supportRechargePaymentCode.findMany({
      where: {
        enabled: true,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gt: now } }],
      },
      orderBy: [{ validUntil: 'asc' }, { createdAt: 'asc' }],
    });
    if (codes.length === 0) {
      await this.messages.insertServerMessage(message.conversationID, {
        senderID: agentUserID,
        type: 'text',
        content: {
          text: '当前付款通道正在调整，暂时没有可用的收款码。你的消息已经保留，请等待人工客服处理，不要向历史二维码付款。',
        },
        clientMessageId: `sr-unavailable-${message.id}`,
        push: true,
      });
      return;
    }

    const active = await this.prisma.supportRechargeOrder.findFirst({
      where: {
        conversationID: message.conversationID,
        userID: message.senderID!,
        status: { in: ['AWAITING_PROOF', 'WAITING_REVIEW', 'PROCESSING'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (active?.status === 'AWAITING_PROOF') {
      await this.messages.insertServerMessage(message.conversationID, {
        senderID: agentUserID,
        type: 'text',
        content: {
          text: `充值申请 ${active.orderNo} 正在等待付款截图，请勿重复付款。`,
        },
        clientMessageId: `sr-awaiting-proof-${message.id}`,
        push: true,
      });
      return;
    }

    const order =
      active ?? (await this.createOrder(message, agentUserID, requestKind));

    if (order.status === 'WAITING_REVIEW' || order.status === 'PROCESSING') {
      await this.messages.insertServerMessage(message.conversationID, {
        senderID: agentUserID,
        type: 'text',
        content: {
          text:
            order.status === 'PROCESSING'
              ? `充值申请 ${order.orderNo} 已核对，正在发放，请勿重复付款。`
              : `充值申请 ${order.orderNo} 正在人工核对，请勿重复付款。`,
        },
        clientMessageId: `sr-pending-${message.id}`,
        push: true,
      });
      return;
    }

    const paymentMethods = codes
      .map((code, index) =>
        codes.length === 1 ? code.label : `${index + 1}. ${code.label}`,
      )
      .join('\n');
    await this.messages.insertServerMessage(message.conversationID, {
      senderID: agentUserID,
      type: 'text',
      content: {
        text: `充值申请：${order.orderNo}\n付款方式：${paymentMethods}\n请使用下方收款码付款，勿使用历史二维码。付款后发送转账截图（保留金额、时间和交易编号）。`,
      },
      clientMessageId: `sr-intro-${message.id}`,
      push: true,
    });
    for (const code of codes) {
      // 每条二维码消息使用自己的对象。聊天撤回/焚毁会物删该消息的媒体；如果
      // 直接复用配置原图，撤回任一历史消息就会让所有会话和后续发送一起失效。
      const extension = code.objectKey.split('.').pop()?.toLowerCase() || 'png';
      const deliveryKey = `chat/${agentUserID}/${message.id}-${code.id}.${extension}`;
      await this.upload.copyObjectToKey(code.objectKey, deliveryKey);
      await this.messages.insertServerMessage(message.conversationID, {
        senderID: agentUserID,
        type: 'image',
        content: { key: deliveryKey },
        clientMessageId: `sr-code-${message.id}-${code.id}`,
      });
    }
    await this.prisma.supportRechargeConversationState.update({
      where: { conversationID: message.conversationID },
      data: { lastWelcomeAt: now },
    });
  }

  private async createOrder(
    message: IncomingMessage,
    agentUserID: string,
    requestKind: SupportRechargeRequestKind,
  ): Promise<SupportRechargeOrder> {
    const replay = await this.prisma.supportRechargeOrder.findUnique({
      where: { sourceMessageID: message.id },
    });
    if (replay) return replay;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.supportRechargeOrder.create({
          data: {
            orderNo: orderNo(),
            conversationID: message.conversationID,
            userID: message.senderID!,
            agentUserID,
            sourceMessageID: message.id,
            requestKind,
          },
        });
      } catch (error) {
        const bySource = await this.prisma.supportRechargeOrder.findUnique({
          where: { sourceMessageID: message.id },
        });
        if (bySource) return bySource;
        if (attempt === 2) throw error;
      }
    }
    throw new Error('failed to create support recharge order');
  }

  private async acceptPaymentEvidence(
    message: IncomingMessage,
    agentUserID: string,
  ): Promise<void> {
    const key = messageObjectKey(message);
    if (!key) return;
    let order = await this.prisma.supportRechargeOrder.findFirst({
      where: {
        conversationID: message.conversationID,
        userID: message.senderID!,
        status: 'AWAITING_PROOF',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (order) {
      const changed = await this.prisma.supportRechargeOrder.updateMany({
        where: { id: order.id, status: 'AWAITING_PROOF' },
        data: {
          status: 'WAITING_REVIEW',
          evidenceMessageID: message.id,
          evidenceObjectKey: key,
          submittedAt: new Date(),
        },
      });
      if (changed.count === 1) {
        order = await this.prisma.supportRechargeOrder.findUniqueOrThrow({
          where: { id: order.id },
        });
      }
    } else {
      order = await this.prisma.supportRechargeOrder.findFirst({
        where: {
          conversationID: message.conversationID,
          userID: message.senderID!,
          status: { in: ['WAITING_REVIEW', 'PROCESSING'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      // 人工开始处理前，用户补发的更清晰截图应成为审核台看到的最新版。
      // PROCESSING 后不再替换证据，避免管理员核对期间页面里的依据悄悄变化。
      if (order?.status === 'WAITING_REVIEW') {
        const changed = await this.prisma.supportRechargeOrder.updateMany({
          where: { id: order.id, status: 'WAITING_REVIEW' },
          data: {
            evidenceMessageID: message.id,
            evidenceObjectKey: key,
            submittedAt: new Date(),
          },
        });
        if (changed.count === 1) {
          order = await this.prisma.supportRechargeOrder.findUniqueOrThrow({
            where: { id: order.id },
          });
        }
      }
    }

    if (!order) {
      await this.messages.insertServerMessage(message.conversationID, {
        senderID: agentUserID,
        type: 'text',
        content: {
          text: '我还没有找到与你对应的充值申请。请先发送“积分”或“会员”，获取当前付款步骤后再提交记录。',
        },
        clientMessageId: `sr-no-order-${message.id}`,
        push: true,
      });
      return;
    }

    await this.messages.insertServerMessage(message.conversationID, {
      senderID: agentUserID,
      type: 'text',
      content: {
        text:
          `已收到充值申请 ${order.orderNo} 的付款记录，现已进入人工核对。` +
          '核对完成后会在本会话告知处理结果，请不要重复付款。',
      },
      clientMessageId: `sr-evidence-${message.id}`,
      push: true,
    });
  }
}
