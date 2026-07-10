import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';

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
};

@Injectable()
export class FriendChatReplayOutboxProcessor {
  private readonly logger = new Logger(FriendChatReplayOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
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
    const claimed = await this.prisma.friendChatReplayOutbox.updateMany({
      where: { id: job.id, status: job.status },
      data: { status: 'PROCESSING', lockedAt: new Date() },
    });
    if (claimed.count === 0) return;

    try {
      let stage = job.stage;
      if (stage === 0) {
        await this.openimService.importFriends(job.requesterUserID, [
          job.accepterUserID,
        ]);
        stage = 1;
        await this.persistProgress(job.id, { stage, lockedAt: new Date() });
      }
      if (stage === 1) {
        await this.openimService.importFriends(job.accepterUserID, [
          job.requesterUserID,
        ]);
        stage = 2;
        await this.persistProgress(job.id, { stage, lockedAt: new Date() });
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
        if (replay.length > 0) {
          for (
            let index = job.messageIndex;
            index < replay.length;
            index += 1
          ) {
            const message = replay[index];
            const fromRequester = message.senderId === job.requesterUserID;
            await this.openimService.sendTextMessage({
              sendID: message.senderId,
              recvID: fromRequester ? job.accepterUserID : job.requesterUserID,
              content: message.content,
              senderNickname: fromRequester ? requesterName : accepterName,
              senderFaceURL:
                (fromRequester ? requester : accepter)?.avatarUrl ?? '',
              notOfflinePush: true,
              clientMsgID: `friend-request:${job.requestId}:${message.id}`,
            });
            job.messageIndex = index + 1;
            await this.persistProgress(job.id, {
              stage: 2,
              messageIndex: job.messageIndex,
              lockedAt: new Date(),
            });
          }
        } else {
          const greeting = request?.message?.trim() || `我是${requesterName}`;
          await this.openimService.sendTextMessage({
            sendID: job.requesterUserID,
            recvID: job.accepterUserID,
            content: greeting,
            senderNickname: requesterName,
            senderFaceURL: requester?.avatarUrl ?? '',
            notOfflinePush: true,
            clientMsgID: `friend-request:${job.requestId}:greeting`,
          });
        }
        stage = 3;
        await this.persistProgress(job.id, { stage, lockedAt: new Date() });
      }

      if (stage === 3) {
        await this.openimService.sendTextMessage({
          sendID: job.accepterUserID,
          recvID: job.requesterUserID,
          content: ACCEPTED_REPLY,
          senderNickname: accepterName,
          senderFaceURL: accepter?.avatarUrl ?? '',
          notOfflinePush: true,
          clientMsgID: `friend-request:${job.requestId}:accepted`,
        });
      }

      await this.prisma.friendChatReplayOutbox.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          stage: 4,
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.friendChatReplayOutbox.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: message.slice(0, 1000),
          nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          lockedAt: null,
        },
      });
      this.logger.warn(`Friend chat replay failed for ${job.id}: ${message}`);
    }
  }

  private async persistProgress(
    jobId: string,
    data: { stage: number; messageIndex?: number; lockedAt: Date },
  ): Promise<void> {
    await this.prisma.friendChatReplayOutbox.update({
      where: { id: jobId },
      data,
    });
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

  private displayName(
    user: { nickname?: string | null; accountId?: string | null } | null,
    fallback: string,
  ): string {
    return user?.nickname?.trim() || user?.accountId?.trim() || fallback;
  }
}
