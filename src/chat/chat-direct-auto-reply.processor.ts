import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import type { ChatMessage, Prisma } from 'src/generated/prisma';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import {
  reportHandledJobFailure,
  reportJobSkipped,
  TrackedCron,
} from 'src/metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { SensitiveWordService } from 'src/sensitive-word/sensitive-word.service';
import { lockUserRelationshipState } from 'src/utils/user-relationship-lock';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatPushService } from './chat-push.service';
import type { ChatMessageDto } from './chat.types';

const JOB_BATCH = 20;
const JOB_MAX_ATTEMPTS = 5;
const JOB_STALE_MS = 2 * 60_000;
const JOB_BACKOFF_BASE_MS = 2_000;
const JOB_BACKOFF_MAX_MS = 60_000;
const AUTO_REPLY_COOLDOWN_MS = 30_000;
/**
 * 每会话冷却之外的**全局**上限：同一个应答者在这个窗口内最多向这么多个不同
 * 会话自动回复。
 *
 * 30 秒的每会话冷却只挡得住一个人反复戳。1000 个号各发一条私聊，就是 1000 条
 * 自动回复 —— 每条都是一次取会话行锁、两把关系锁和用户行锁的写事务，外加一次
 * 广播和一次推送，而发起方的成本是发一条消息。上限打满后这一轮直接把 job 收掉：
 * 自动回复是礼貌，不是投递保证，丢掉一条远好过让别人用你的账号当放大器。
 */
const AUTO_REPLY_WINDOW_MS = 60_000;
const AUTO_REPLY_MAX_CONVERSATIONS_PER_WINDOW = 20;
const PROCESSING_FAILED = 'PROCESSING_FAILED';
const TERMINAL_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
const COOLDOWN_STATE_RETENTION_MS = 24 * 60 * 60_000;
const CLEANUP_BATCH = 1000;

type SourceMessage = ChatMessage & {
  conversation: { id: string; type: string };
};

/** Durable account-level direct-message auto replies. */
@Injectable()
export class ChatDirectAutoReplyProcessor {
  private readonly logger = new Logger(ChatDirectAutoReplyProcessor.name);
  private sweeping = false;
  private cleaning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly push: ChatPushService,
    private readonly sensitiveWords: SensitiveWordService,
  ) {}

  /** Low-latency post-commit kick; the cron sweep remains the durable fallback. */
  async processMessage(sourceMessageID: string): Promise<void> {
    const job = await this.prisma.chatDirectAutoReplyJob.findUnique({
      where: { sourceMessageID },
      select: { id: true },
    });
    if (job) await this.processJob(job.id);
  }

  @TrackedCron(CronExpression.EVERY_MINUTE, 'chat_direct_auto_reply_jobs')
  async sweep(): Promise<void> {
    if (this.sweeping) {
      reportJobSkipped();
      return;
    }
    this.sweeping = true;
    try {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - JOB_STALE_MS);
      await this.prisma.chatDirectAutoReplyJob.updateMany({
        where: {
          status: 'PROCESSING',
          attempts: { lt: JOB_MAX_ATTEMPTS },
          lockedAt: { lt: staleBefore },
        },
        data: { status: 'PENDING', lockedAt: null, nextAttemptAt: now },
      });
      await this.prisma.chatDirectAutoReplyJob.updateMany({
        where: {
          status: 'PROCESSING',
          attempts: { gte: JOB_MAX_ATTEMPTS },
          lockedAt: { lt: staleBefore },
        },
        data: {
          status: 'FAILED',
          lockedAt: null,
          lastError: PROCESSING_FAILED,
        },
      });
      const due = await this.prisma.chatDirectAutoReplyJob.findMany({
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

  @TrackedCron(
    CronExpression.EVERY_DAY_AT_4AM,
    'chat_direct_auto_reply_cleanup',
  )
  async cleanupExpired(now = new Date()): Promise<void> {
    if (this.cleaning) {
      reportJobSkipped();
      return;
    }
    this.cleaning = true;
    try {
      const terminalCutoff = new Date(
        now.getTime() - TERMINAL_JOB_RETENTION_MS,
      );
      let jobsBatchSize = 0;
      do {
        const jobs = await this.prisma.chatDirectAutoReplyJob.findMany({
          where: {
            status: { in: ['COMPLETED', 'FAILED'] },
            updatedAt: { lt: terminalCutoff },
          },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: CLEANUP_BATCH,
          select: { id: true },
        });
        jobsBatchSize = jobs.length;
        if (jobsBatchSize > 0) {
          await this.prisma.chatDirectAutoReplyJob.deleteMany({
            where: {
              id: { in: jobs.map((job) => job.id) },
              status: { in: ['COMPLETED', 'FAILED'] },
              updatedAt: { lt: terminalCutoff },
            },
          });
        }
      } while (jobsBatchSize === CLEANUP_BATCH);

      const stateCutoff = new Date(now.getTime() - COOLDOWN_STATE_RETENTION_MS);
      let statesBatchSize = 0;
      do {
        const states = await this.prisma.chatDirectAutoReplyState.findMany({
          where: { updatedAt: { lt: stateCutoff } },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: CLEANUP_BATCH,
          select: { id: true },
        });
        statesBatchSize = states.length;
        if (statesBatchSize > 0) {
          await this.prisma.chatDirectAutoReplyState.deleteMany({
            where: {
              id: { in: states.map((state) => state.id) },
              updatedAt: { lt: stateCutoff },
            },
          });
        }
      } while (statesBatchSize === CLEANUP_BATCH);
    } finally {
      this.cleaning = false;
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const lockedAt = new Date();
    const claimed = await this.prisma.chatDirectAutoReplyJob.updateMany({
      where: {
        id: jobId,
        status: 'PENDING',
        attempts: { lt: JOB_MAX_ATTEMPTS },
        nextAttemptAt: { lte: lockedAt },
      },
      data: { status: 'PROCESSING', lockedAt, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;

    let attempts = 1;
    try {
      const job = await this.prisma.chatDirectAutoReplyJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { sourceMessageID: true, attempts: true },
      });
      attempts = job.attempts;
      const message = await this.createReply(jobId, job.sourceMessageID);
      if (message) await this.deliverCommittedReply(message);
    } catch (error) {
      // 这个 catch 把异常吞掉并改写行状态，然后正常返回 —— 于是 sweep() 永远
      // resolve，TrackedCron 的心跳在整段故障期间照常前进：CronJobFailing 打不中
      // （没抛），CronJobStalled 也打不中（心跳新鲜），而自动回复其实已经停摆。
      // tracked-cron.decorator 就是为这种「吞掉异常后正常返回」的任务准备的。
      // 脱离 cron 上下文（网关的即时 kick）调用是无操作，所以两条路径都安全。
      reportHandledJobFailure();
      const terminal = attempts >= JOB_MAX_ATTEMPTS;
      const delay = Math.min(
        JOB_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
        JOB_BACKOFF_MAX_MS,
      );
      await this.prisma.chatDirectAutoReplyJob.update({
        where: { id: jobId },
        data: {
          status: terminal ? 'FAILED' : 'PENDING',
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + delay),
          lastError: PROCESSING_FAILED,
        },
      });
      this.logger[terminal ? 'error' : 'warn']({
        event: terminal
          ? 'direct_auto_reply_dead_lettered'
          : 'direct_auto_reply_retry_scheduled',
        attempt: attempts,
        category: PROCESSING_FAILED,
      });
      // 死信是「这条自动回复永远发不出去了」。只写一行 logger.error 的话，它散在
      // 日志里，没有任何聚合信号；reportOperationalError 按 component/operation/kind
      // 归并，一次系统性故障才看得出是一片而不是一条。
      if (terminal) {
        reportOperationalError(error, {
          component: 'chat',
          operation: 'directAutoReply',
          kind: 'deadLettered',
        });
      }
    }
  }

  private async createReply(
    jobId: string,
    sourceMessageID: string,
  ): Promise<ChatMessageDto | null> {
    return this.prisma.$transaction(async (tx) => {
      const source = await tx.chatMessage.findUnique({
        where: { id: sourceMessageID },
        include: { conversation: { select: { id: true, type: true } } },
      });
      if (!this.isEligibleSource(source)) {
        await this.completeJob(tx, jobId);
        return null;
      }
      const message = source as SourceMessage;

      // Serialize all jobs for one conversation before reading members/cooldown.
      const counter = await tx.$queryRaw<Array<{ nextHeight: number }>>`
        SELECT "nextHeight" FROM "ChatConversation"
        WHERE "id" = ${message.conversationID} FOR UPDATE`;
      if (counter.length === 0) {
        await this.completeJob(tx, jobId);
        return null;
      }

      const seats = await tx.chatMember.findMany({
        where: { conversationID: message.conversationID, leftAt: null },
        select: { userID: true },
      });
      const senderIsActive = seats.some(
        (seat) => seat.userID === message.senderID,
      );
      const responders = seats.filter(
        (seat) => seat.userID !== message.senderID,
      );
      if (!senderIsActive || responders.length !== 1) {
        await this.completeJob(tx, jobId);
        return null;
      }
      const responderID = responders[0].userID;

      // Block/unblock and privacy updates use these same stable-order locks.
      // Holding the conversation row lock at the same time keeps membership and
      // authorization fixed through the reply insert.
      await lockUserRelationshipState(tx, [message.senderID, responderID]);
      const currentSeats = await tx.chatMember.findMany({
        where: { conversationID: message.conversationID, leftAt: null },
        select: { userID: true },
      });
      if (
        currentSeats.length !== 2 ||
        !currentSeats.some((seat) => seat.userID === message.senderID) ||
        !currentSeats.some((seat) => seat.userID === responderID)
      ) {
        await this.completeJob(tx, jobId);
        return null;
      }
      const blocked = await tx.block.findFirst({
        where: {
          OR: [
            { blockerID: message.senderID, blockedID: responderID },
            { blockerID: responderID, blockedID: message.senderID },
          ],
        },
        select: { id: true },
      });
      if (blocked) {
        await this.completeJob(tx, jobId);
        return null;
      }
      const respondersByStatus = await tx.$queryRaw<
        Array<{
          id: string;
          nickname: string;
          avatarUrl: string | null;
          status: string;
        }>
      >`
        SELECT "id", "nickname", "avatarUrl", "status"
        FROM "User" WHERE "id" = ${responderID} FOR UPDATE`;
      const responder = respondersByStatus[0];
      if (!responder || responder.status !== 'ACTIVE') {
        await this.completeJob(tx, jobId);
        return null;
      }

      const settings = await tx.userPrivacySetting.findUnique({
        where: { userID: responderID },
        select: {
          directMessageAutoReplyEnabled: true,
          directMessageAutoReplyText: true,
        },
      });
      const text = settings?.directMessageAutoReplyText.trim() ?? '';
      if (!settings?.directMessageAutoReplyEnabled || !text) {
        await this.completeJob(tx, jobId);
        return null;
      }
      if (this.sensitiveWords.check(text).blocked) {
        await this.completeJob(tx, jobId);
        return null;
      }

      const clientMessageId = `dm-auto:${message.id}:${responderID}`;
      const existing = await tx.chatMessage.findUnique({
        where: {
          conversationID_senderID_clientMessageId: {
            conversationID: message.conversationID,
            senderID: responderID,
            clientMessageId,
          },
        },
      });
      if (existing) {
        await this.completeJob(tx, jobId);
        return null;
      }

      const state = await tx.chatDirectAutoReplyState.findUnique({
        where: {
          conversationID_responderID: {
            conversationID: message.conversationID,
            responderID,
          },
        },
        select: { lastRepliedAt: true },
      });
      const clock = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"`;
      if (clock.length === 0) throw new Error('database clock unavailable');
      const now = clock[0].now;
      if (
        state &&
        now.getTime() - state.lastRepliedAt.getTime() < AUTO_REPLY_COOLDOWN_MS
      ) {
        await this.completeJob(tx, jobId);
        return null;
      }

      // 数的是「窗口内有多少个不同会话被这个应答者回过」。每个会话本来就有 30 秒
      // 冷却，所以这个数与实际回复条数在同一量级，而 @@index([responderID,
      // lastRepliedAt]) 已经在 schema 里，这一查是走索引的计数。
      //
      // 咨询锁只到会话粒度，不同会话的 job 会并发跑，因此这是个**软**上限：
      // 并发下可能溢出几条。限流够用了 —— 它不是正确性不变量，真正要挡的是
      // 「一个账号被当成无限放大器」这个量级差。
      const recentConversations = await tx.chatDirectAutoReplyState.count({
        where: {
          responderID,
          lastRepliedAt: {
            gte: new Date(now.getTime() - AUTO_REPLY_WINDOW_MS),
          },
        },
      });
      if (recentConversations >= AUTO_REPLY_MAX_CONVERSATIONS_PER_WINDOW) {
        this.logger.warn({
          event: 'direct_auto_reply_rate_limited',
          responderID,
          recentConversations,
          windowMs: AUTO_REPLY_WINDOW_MS,
        });
        await this.completeJob(tx, jobId);
        return null;
      }

      const height = counter[0].nextHeight + 1;
      const content = { text, autoReply: true };
      const created = await tx.chatMessage.create({
        data: {
          conversationID: message.conversationID,
          height,
          senderID: responderID,
          type: 'text',
          content: content as Prisma.InputJsonObject,
          clientMessageId,
          replyToID: null,
          createdAt: now,
        },
      });
      await tx.chatConversation.update({
        where: { id: message.conversationID },
        data: { nextHeight: height, lastMessageAt: now },
      });
      await tx.chatMember.updateMany({
        where: {
          conversationID: message.conversationID,
          hiddenAt: { not: null },
        },
        data: { hiddenAt: null },
      });
      await tx.chatDirectAutoReplyState.upsert({
        where: {
          conversationID_responderID: {
            conversationID: message.conversationID,
            responderID,
          },
        },
        create: {
          conversationID: message.conversationID,
          responderID,
          lastRepliedAt: now,
        },
        update: { lastRepliedAt: now },
      });
      await this.completeJob(tx, jobId);
      return {
        id: created.id,
        conversationId: message.conversationID,
        height: created.height,
        type: created.type,
        content,
        sender: {
          id: responder.id,
          nickname: responder.nickname,
          avatarUrl: responder.avatarUrl,
          // 自动回复只发生在单聊(上面刚断言过恰好两个座位),没有群昵称可言。
          alias: null,
        },
        replyToId: null,
        d: created.clientMessageId,
        createdAt: created.createdAt.toISOString(),
      };
    });
  }

  private isEligibleSource(source: SourceMessage | null): boolean {
    if (
      !source?.senderID ||
      source.conversation.type !== 'DIRECT' ||
      source.deleted ||
      source.revokedAt
    ) {
      return false;
    }
    const content = source.content;
    return !(
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).autoReply === true
    );
  }

  private async completeJob(
    tx: Prisma.TransactionClient,
    jobId: string,
  ): Promise<void> {
    await tx.chatDirectAutoReplyJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', lockedAt: null, lastError: null },
    });
  }

  private async deliverCommittedReply(message: ChatMessageDto): Promise<void> {
    try {
      await this.broadcast.emitMessage(message);
    } catch {
      this.logger.warn({
        event: 'direct_auto_reply_realtime_failed',
        category: 'DELIVERY_FAILED',
      });
    }
    try {
      await this.push.onMessageBroadcast(message);
    } catch {
      this.logger.warn({
        event: 'direct_auto_reply_push_failed',
        category: 'DELIVERY_FAILED',
      });
    }
  }
}
