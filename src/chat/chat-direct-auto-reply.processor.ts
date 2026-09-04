import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import type { ChatMessage, Prisma } from 'src/generated/prisma';
import { TrackedCron } from 'src/metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
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
const PROCESSING_FAILED = 'PROCESSING_FAILED';

type SourceMessage = ChatMessage & {
  conversation: { id: string; type: string };
};

/** Durable account-level direct-message auto replies. */
@Injectable()
export class ChatDirectAutoReplyProcessor {
  private readonly logger = new Logger(ChatDirectAutoReplyProcessor.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly push: ChatPushService,
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
    if (this.sweeping) return;
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
    } catch {
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
