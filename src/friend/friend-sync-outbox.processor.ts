import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';

const FRIEND_SYNC_BATCH_SIZE = 20;
const FRIEND_SYNC_STALE_LOCK_MS = 5 * 60 * 1000;
const FRIEND_SYNC_MAX_BACKOFF_MS = 30 * 60 * 1000;

type FriendSyncJob = {
  id: string;
  operation:
    | 'IMPORT_FRIEND'
    | 'DELETE_FRIEND'
    | 'CLEAR_CONVERSATION'
    | 'ADD_BLACKLIST'
    | 'REMOVE_BLACKLIST';
  status: 'PENDING' | 'PROCESSING' | 'FAILED';
  userID: string;
  targetUserID: string;
  attempts: number;
};

@Injectable()
export class FriendSyncOutboxProcessor {
  private readonly logger = new Logger(FriendSyncOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processPending(): Promise<void> {
    const now = new Date();
    const staleLockBefore = new Date(Date.now() - FRIEND_SYNC_STALE_LOCK_MS);
    const jobs = await this.prisma.friendSyncOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockedAt: { lt: staleLockBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: FRIEND_SYNC_BATCH_SIZE,
    });

    for (const job of jobs as FriendSyncJob[]) {
      await this.processJob(job);
    }
  }

  private async processJob(job: FriendSyncJob): Promise<void> {
    const claimed = await this.prisma.friendSyncOutbox.updateMany({
      where: {
        id: job.id,
        status: job.status,
      },
      data: {
        status: 'PROCESSING',
        lockedAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      return;
    }

    try {
      await this.dispatch(job);
      await this.markCompleted(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isIdempotentOpenimResult(job.operation, message)) {
        await this.markCompleted(job.id);
        this.logger.warn(
          `OpenIM friend sync outbox ${job.id} treated as completed: ${message}`,
        );
        return;
      }

      await this.prisma.friendSyncOutbox.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: message.slice(0, 1000),
          nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          lockedAt: null,
        },
      });
      this.logger.warn(
        `OpenIM friend sync failed for outbox ${job.id}: ${message}`,
      );
    }
  }

  private async dispatch(job: FriendSyncJob): Promise<void> {
    if (job.operation === 'IMPORT_FRIEND') {
      await this.openimService.importFriends(job.userID, [job.targetUserID]);
      return;
    }
    if (job.operation === 'DELETE_FRIEND') {
      await this.openimService.deleteFriend(job.userID, job.targetUserID);
      return;
    }
    if (job.operation === 'CLEAR_CONVERSATION') {
      await this.openimService.clearConversationMessages(job.userID, [
        OpenimService.singleConversationID(job.userID, job.targetUserID),
      ]);
      return;
    }
    if (job.operation === 'ADD_BLACKLIST') {
      await this.openimService.addBlacklist(job.userID, job.targetUserID);
      return;
    }
    await this.openimService.removeBlacklist(job.userID, job.targetUserID);
  }

  private async markCompleted(jobID: string): Promise<void> {
    await this.prisma.friendSyncOutbox.update({
      where: { id: jobID },
      data: {
        status: 'COMPLETED',
        processedAt: new Date(),
        lastError: null,
        lockedAt: null,
      },
    });
  }

  private nextRetryAt(attempts: number): Date {
    const delayMs = Math.min(
      FRIEND_SYNC_MAX_BACKOFF_MS,
      60_000 * 2 ** Math.max(0, attempts - 1),
    );
    return new Date(Date.now() + delayMs);
  }

  private isIdempotentOpenimResult(
    operation: FriendSyncJob['operation'],
    message: string,
  ): boolean {
    const normalized = message.toLowerCase();
    if (operation === 'IMPORT_FRIEND' || operation === 'ADD_BLACKLIST') {
      return (
        normalized.includes('already') ||
        normalized.includes('duplicate') ||
        normalized.includes('repeated') ||
        normalized.includes('exist')
      );
    }

    return (
      normalized.includes('recordnotfound') ||
      normalized.includes('not found') ||
      normalized.includes('not friend') ||
      normalized.includes('not in black') ||
      normalized.includes('black not exist') ||
      normalized.includes('does not exist')
    );
  }
}
