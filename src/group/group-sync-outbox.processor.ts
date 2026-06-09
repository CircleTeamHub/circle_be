import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';

const GROUP_SYNC_BATCH_SIZE = 20;
const GROUP_SYNC_STALE_LOCK_MS = 5 * 60 * 1000;
const GROUP_SYNC_MAX_BACKOFF_MS = 30 * 60 * 1000;

type GroupSyncJob = {
  id: string;
  operation: 'ADD_MEMBER' | 'REMOVE_MEMBER';
  status: 'PENDING' | 'PROCESSING' | 'FAILED';
  groupID: string;
  userID: string;
  attempts: number;
};

@Injectable()
export class GroupSyncOutboxProcessor {
  private readonly logger = new Logger(GroupSyncOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processPending(): Promise<void> {
    const now = new Date();
    const staleLockBefore = new Date(Date.now() - GROUP_SYNC_STALE_LOCK_MS);
    const jobs = await this.prisma.groupSyncOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockedAt: { lt: staleLockBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: GROUP_SYNC_BATCH_SIZE,
    });

    for (const job of jobs as GroupSyncJob[]) {
      await this.processJob(job);
    }
  }

  private async processJob(job: GroupSyncJob): Promise<void> {
    const claimed = await this.prisma.groupSyncOutbox.updateMany({
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
      if (job.operation === 'ADD_MEMBER') {
        await this.openimService.addGroupMembers(job.groupID, [job.userID]);
      } else {
        await this.openimService.removeGroupMember(job.groupID, job.userID);
      }

      await this.prisma.groupSyncOutbox.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
          lastError: null,
          lockedAt: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isIdempotentOpenimResult(job.operation, message)) {
        await this.markCompleted(job.id);
        this.logger.warn(
          `OpenIM group sync outbox ${job.id} treated as completed: ${message}`,
        );
        return;
      }

      await this.prisma.groupSyncOutbox.update({
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
        `OpenIM group sync failed for outbox ${job.id}: ${message}`,
      );
    }
  }

  private async markCompleted(jobID: string): Promise<void> {
    await this.prisma.groupSyncOutbox.update({
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
      GROUP_SYNC_MAX_BACKOFF_MS,
      60_000 * 2 ** Math.max(0, attempts - 1),
    );
    return new Date(Date.now() + delayMs);
  }

  private isIdempotentOpenimResult(
    operation: GroupSyncJob['operation'],
    message: string,
  ): boolean {
    const normalized = message.toLowerCase();
    if (operation === 'ADD_MEMBER') {
      return (
        normalized.includes('group member repeated') ||
        normalized.includes('already') ||
        normalized.includes('duplicate')
      );
    }

    return (
      normalized.includes('not group member') ||
      normalized.includes('not in group') ||
      normalized.includes('recordnotfound') ||
      normalized.includes('member not exist') ||
      normalized.includes('member does not exist')
    );
  }
}
