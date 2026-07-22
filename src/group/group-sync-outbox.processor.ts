import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { enqueueCircleMemberSync } from 'src/circle/circle-member-sync';
import { GroupSyncOperation, Prisma } from 'src/generated/prisma';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';

const GROUP_SYNC_BATCH_SIZE = 20;
const GROUP_SYNC_STALE_LOCK_MS = 5 * 60 * 1000;
const GROUP_SYNC_MAX_BACKOFF_MS = 30 * 60 * 1000;

type GroupSyncJob = {
  id: string;
  operation: GroupSyncOperation;
  status: 'PENDING' | 'PROCESSING' | 'FAILED';
  groupID: string;
  userID: string;
  attempts: number;
};

type CircleLookup = { id: string } | null;

type ExternalResult =
  | { outcome: 'SUCCEEDED'; idempotentMessage?: string }
  | { outcome: 'FAILED'; message: string };

@Injectable()
export class GroupSyncOutboxProcessor {
  private readonly logger = new Logger(GroupSyncOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
    private readonly memberLock: CircleMemberLockService,
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
    const claimed = await this.claimCurrentGeneration(job);
    if (!claimed) return;

    // No transaction or advisory lock is held across this network boundary.
    const result = await this.applyExternalEffect(job);
    await this.finalizeOrReconcile(job, result);
  }

  private async claimCurrentGeneration(job: GroupSyncJob): Promise<boolean> {
    const circle = await this.findCircle(job.groupID);
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockIfMapped(tx, circle, job);
      const claimed = await tx.groupSyncOutbox.updateMany({
        where: {
          id: job.id,
          operation: job.operation,
          status: job.status,
        },
        data: {
          status: 'PROCESSING',
          lockedAt: new Date(),
        },
      });
      if (claimed.count === 0) return false;

      const desiredOperation = await this.readDesiredOperation(tx, circle, job);
      if (desiredOperation !== job.operation) {
        await enqueueCircleMemberSync(tx, desiredOperation, job.groupID, [
          job.userID,
        ]);
        return false;
      }
      return true;
    });
  }

  private async finalizeOrReconcile(
    job: GroupSyncJob,
    result: ExternalResult,
  ): Promise<void> {
    const circle = await this.findCircle(job.groupID);
    await runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockIfMapped(tx, circle, job);
      const currentGeneration = await tx.groupSyncOutbox.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      const desiredOperation = await this.readDesiredOperation(tx, circle, job);
      const isCurrentGeneration = currentGeneration?.status === 'PROCESSING';

      if (!isCurrentGeneration || desiredOperation !== job.operation) {
        await enqueueCircleMemberSync(tx, desiredOperation, job.groupID, [
          job.userID,
        ]);
        return;
      }

      if (result.outcome === 'SUCCEEDED') {
        await tx.groupSyncOutbox.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            processedAt: new Date(),
            lastError: null,
            lockedAt: null,
          },
        });
        if (result.idempotentMessage) {
          this.logger.warn(
            `OpenIM group sync outbox ${job.id} treated as completed: ${result.idempotentMessage}`,
          );
        }
        return;
      }

      await tx.groupSyncOutbox.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: result.message.slice(0, 1000),
          nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          lockedAt: null,
        },
      });
      this.logger.warn(
        `OpenIM group sync failed for outbox ${job.id}: ${result.message}`,
      );
    });
  }

  private async applyExternalEffect(
    job: GroupSyncJob,
  ): Promise<ExternalResult> {
    try {
      if (job.operation === 'ADD_MEMBER') {
        await this.openimService.addGroupMembers(job.groupID, [job.userID]);
      } else {
        await this.openimService.removeGroupMember(job.groupID, job.userID);
      }
      return { outcome: 'SUCCEEDED' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isIdempotentOpenimResult(job.operation, message)) {
        return { outcome: 'SUCCEEDED', idempotentMessage: message };
      }
      return { outcome: 'FAILED', message };
    }
  }

  private async readDesiredOperation(
    tx: Prisma.TransactionClient,
    circle: CircleLookup,
    job: GroupSyncJob,
  ): Promise<GroupSyncOperation> {
    if (!circle) return 'REMOVE_MEMBER';

    const currentCircle = await tx.circle.findUnique({
      where: { id: circle.id },
      select: { groupID: true },
    });
    const membership = await tx.circleMember.findUnique({
      where: {
        userID_circleID: {
          userID: job.userID,
          circleID: circle.id,
        },
      },
      select: { status: true },
    });
    const mappingMatches =
      currentCircle !== null &&
      (currentCircle.groupID ?? circle.id) === job.groupID;
    return mappingMatches && membership?.status === 'ACTIVE'
      ? 'ADD_MEMBER'
      : 'REMOVE_MEMBER';
  }

  private async lockIfMapped(
    tx: Prisma.TransactionClient,
    circle: CircleLookup,
    job: GroupSyncJob,
  ): Promise<void> {
    if (circle) {
      await this.memberLock.lock(tx, circle.id, [job.userID]);
    }
  }

  private findCircle(groupID: string): Promise<CircleLookup> {
    return this.prisma.circle.findFirst({
      where: {
        OR: [{ id: groupID }, { groupID }],
      },
      select: { id: true },
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
    operation: GroupSyncOperation,
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
