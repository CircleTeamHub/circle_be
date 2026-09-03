import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { randomUUID } from 'crypto';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SensitiveWordService } from 'src/sensitive-word/sensitive-word.service';
import { reportOperationalError } from 'src/logging/error-aggregation.service';

const REPLAY_BATCH_SIZE = 20;
const REPLAY_STALE_LOCK_MS = 5 * 60 * 1000;
const REPLAY_MAX_BACKOFF_MS = 30 * 60 * 1000;
const ACCEPTED_REPLY = '我通过了你的好友请求，现在开始聊天吧';

type ReplayJob = {
  id: string;
  requestId: string;
  requesterUserID: string;
  accepterUserID: string;
  status: 'PENDING' | 'PROCESSING' | 'FAILED';
  stage: number;
  messageIndex: number;
  attempts: number;
  lockedAt?: Date | null;
};

@Injectable()
export class FriendChatReplayOutboxProcessor {
  private readonly logger = new Logger(FriendChatReplayOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly chatMessages: ChatSystemMessageService,
    private readonly sensitiveWords: SensitiveWordService,
  ) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'friend_chat_replay_outbox')
  async processPending(): Promise<void> {
    const now = new Date();
    const staleBefore = new Date(Date.now() - REPLAY_STALE_LOCK_MS);
    const jobs = await this.prisma.friendChatReplayOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: REPLAY_BATCH_SIZE,
    });

    for (const job of jobs as ReplayJob[]) {
      await this.processJob(job);
    }
  }

  private async processJob(job: ReplayJob): Promise<void> {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.friendChatReplayOutbox.updateMany({
      where: {
        id: job.id,
        status: job.status,
        ...(job.status === 'PROCESSING' ? { lockedAt: job.lockedAt } : {}),
      },
      data: { status: 'PROCESSING', leaseToken, lockedAt: new Date() },
    });
    if (claimed.count === 0) return;

    try {
      let stage = job.stage;
      if (stage === 0) {
        stage = 1;
        await this.persistProgress(job.id, leaseToken, {
          stage,
          lockedAt: new Date(),
        });
      }
      if (stage === 1) {
        stage = 2;
        await this.persistProgress(job.id, leaseToken, {
          stage,
          lockedAt: new Date(),
        });
      }

      const [request, thread, requester, accepter] = await Promise.all([
        this.prisma.friend.findUnique({
          where: { id: job.requestId },
          select: { message: true },
        }),
        this.prisma.friendRequestMessage.findMany({
          where: { requestId: job.requestId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, senderId: true, content: true },
        }),
        this.prisma.user.findUnique({
          where: { id: job.requesterUserID },
          select: { nickname: true, accountId: true, avatarUrl: true },
        }),
        this.prisma.user.findUnique({
          where: { id: job.accepterUserID },
          select: { nickname: true, accountId: true, avatarUrl: true },
        }),
      ]);
      const requesterName = this.displayName(requester, job.requesterUserID);
      const accepterName = this.displayName(accepter, job.accepterUserID);

      if (stage === 2) {
        const replay = thread ?? [];
        // 会话解析提到循环外:原来每条消息都重解析一次,N 条就是 N 次多余查询。
        const conversationId = await this.replayConversationId(job);
        if (replay.length > 0) {
          for (
            let index = job.messageIndex;
            index < replay.length;
            index += 1
          ) {
            const message = replay[index];
            // 申请线程里的文本是**用户写的**,而 insertServerMessage 是特权原语、
            // 不过敏感词。不拦的话:把违禁词写进好友申请,等对方一通过,它就以
            // 普通聊天消息的身份落库并广播 —— 同样的话走 socket 发会被直接拒。
            // 好友申请创建处也没有这道校验,所以这里是唯一的关卡。
            if (this.isBlockedText(message.content, job.requestId)) {
              job.messageIndex = index + 1;
              await this.persistProgress(job.id, leaseToken, {
                stage: 2,
                messageIndex: job.messageIndex,
                lockedAt: new Date(),
              });
              continue;
            }
            await this.chatMessages.insertServerMessage(conversationId, {
              senderID: message.senderId,
              type: 'text',
              content: { text: message.content },
              clientMessageId: `friend-request:${job.requestId}:${message.id}`,
            });
            job.messageIndex = index + 1;
            await this.persistProgress(job.id, leaseToken, {
              stage: 2,
              messageIndex: job.messageIndex,
              lockedAt: new Date(),
            });
          }
        } else {
          const greeting = request?.message?.trim() || `我是${requesterName}`;
          // 同上:招呼语来自申请人。兜底文案「我是{昵称}」里的昵称也是用户可控的。
          if (!this.isBlockedText(greeting, job.requestId)) {
            await this.chatMessages.insertServerMessage(conversationId, {
              senderID: job.requesterUserID,
              type: 'text',
              content: { text: greeting },
              clientMessageId: `friend-request:${job.requestId}:greeting`,
            });
          }
        }
        stage = 3;
        await this.persistProgress(job.id, leaseToken, {
          stage,
          lockedAt: new Date(),
        });
      }

      if (stage === 3) {
        // ACCEPTED_REPLY 是服务端常量,不过敏感词。
        const conversationId = await this.replayConversationId(job);
        await this.chatMessages.insertServerMessage(conversationId, {
          senderID: job.accepterUserID,
          type: 'text',
          content: { text: ACCEPTED_REPLY },
          clientMessageId: `friend-request:${job.requestId}:accepted`,
        });
      }

      await this.prisma.friendChatReplayOutbox.updateMany({
        where: { id: job.id, leaseToken, status: 'PROCESSING' },
        data: {
          status: 'COMPLETED',
          stage: 4,
          processedAt: new Date(),
          lockedAt: null,
          leaseToken: null,
          lastError: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.friendChatReplayOutbox.updateMany({
        where: { id: job.id, leaseToken, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: message.slice(0, 1000),
          nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          lockedAt: null,
          leaseToken: null,
        },
      });
      this.logger.warn(`Friend chat replay failed for ${job.id}: ${message}`);
      reportOperationalError(error, {
        component: 'FriendChatReplayOutboxProcessor',
        operation: 'processJob',
        kind: 'replay',
      });
    }
  }

  private async persistProgress(
    jobId: string,
    leaseToken: string,
    data: { stage: number; messageIndex?: number; lockedAt: Date },
  ): Promise<void> {
    const updated = await this.prisma.friendChatReplayOutbox.updateMany({
      where: { id: jobId, leaseToken, status: 'PROCESSING' },
      data,
    });
    if (updated.count === 0) {
      throw new Error(`Friend chat replay lease lost for ${jobId}`);
    }
  }

  private nextRetryAt(attempts: number): Date {
    return new Date(
      Date.now() +
        Math.min(
          REPLAY_MAX_BACKOFF_MS,
          60_000 * 2 ** Math.max(0, attempts - 1),
        ),
    );
  }

  /**
   * 回放用的单聊会话 id —— 走结算专用解析,不过拉黑/陌生人消息两道闸。
   *
   * 那两道是给用户主动发消息设的。好友申请**已经被接受**,这些消息是既成事实
   * 的补投:任一方在接受之后、回放跑完之前拉黑,交互式路径会让整个 outbox 作业
   * 永久失败,申请线程一条都补不出来。与转账卡补偿、通话留痕同一条判据。
   */
  private replayConversationId(job: {
    requesterUserID: string;
    accepterUserID: string;
  }): Promise<string> {
    return this.chatService.ensureDirectConversationForSettlement(
      job.requesterUserID,
      job.accepterUserID,
    );
  }

  /**
   * 命中敏感词的回放文本一律丢弃(不落库、不广播),并记一条。
   *
   * 不能像正常发送那样"拒绝"——申请早就被接受了,没有可以回报错误的调用方;
   * 也不该原样放行:那等于给了一条绕过敏感词的通道。丢弃与 socket 发送路径
   * 的判定一致(同样的话走 socket 会被直接拒),只是时机不同。
   */
  private isBlockedText(text: string, requestId: string): boolean {
    const verdict = this.sensitiveWords.check(text);
    if (!verdict.blocked) return false;
    // 只记请求 id 与命中的词,不记正文。
    this.logger.warn(
      `friend-request replay dropped a message containing a blocked word (request=${requestId}, word=${verdict.word})`,
    );
    return true;
  }

  private displayName(
    user: { nickname?: string | null; accountId?: string | null } | null,
    fallback: string,
  ): string {
    return user?.nickname?.trim() || user?.accountId?.trim() || fallback;
  }
}
