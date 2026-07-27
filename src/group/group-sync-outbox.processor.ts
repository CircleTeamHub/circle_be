import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { enqueueCircleMemberSync } from 'src/circle/circle-member-sync';
import {
  GroupSyncOperation,
  GroupSyncStatus,
  Prisma,
} from 'src/generated/prisma';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';

const GROUP_SYNC_BATCH_SIZE = 20;
const GROUP_SYNC_STALE_LOCK_MS = 5 * 60 * 1000;
const GROUP_SYNC_MAX_BACKOFF_MS = 30 * 60 * 1000;

type GroupSyncRow = {
  id: string;
  operation: GroupSyncOperation;
  generation: number;
  processingGeneration: number | null;
  processingOperation: GroupSyncOperation | null;
  status: GroupSyncStatus;
  groupID: string;
  userID: string;
  attempts: number;
  lockedAt: Date | null;
};

type ClaimedAttempt = {
  rowID: string;
  groupID: string;
  userID: string;
  generation: number;
  operation: GroupSyncOperation;
  attempts: number;
  leaseLockedAt: Date;
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
    const rows = await this.prisma.groupSyncOutbox.findMany({
      where: {
        OR: [
          {
            processingGeneration: null,
            status: 'PENDING',
            nextAttemptAt: { lte: now },
          },
          {
            processingGeneration: null,
            status: 'FAILED',
            nextAttemptAt: { lte: now },
          },
          {
            processingGeneration: { not: null },
            processingOperation: { not: null },
            lockedAt: { lt: staleLockBefore },
          },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: GROUP_SYNC_BATCH_SIZE,
    });

    for (const row of rows as GroupSyncRow[]) {
      await this.processRow(row);
    }
  }

  private async processRow(row: GroupSyncRow): Promise<void> {
    const attempt = await this.claim(row);
    if (!attempt) return;

    // Token acquisition and OpenIM calls happen after the claim transaction
    // commits, so no advisory lock or database connection is held here.
    const result = await this.applyExternalEffect(attempt);
    await this.finalize(attempt, result);
  }

  private async claim(row: GroupSyncRow): Promise<ClaimedAttempt | null> {
    const circle = await this.findCircle(row.groupID);
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockIfMapped(tx, circle, row.userID);
      const leaseLockedAt = new Date();

      if (
        row.processingGeneration !== null &&
        row.processingOperation !== null &&
        row.lockedAt !== null
      ) {
        const reclaimed = await tx.groupSyncOutbox.updateMany({
          where: {
            id: row.id,
            generation: row.generation,
            operation: row.operation,
            status: row.status,
            processingGeneration: row.processingGeneration,
            processingOperation: row.processingOperation,
            lockedAt: row.lockedAt,
          },
          data: { lockedAt: leaseLockedAt },
        });
        if (reclaimed.count === 0) return null;
        return {
          rowID: row.id,
          groupID: row.groupID,
          userID: row.userID,
          generation: row.processingGeneration,
          operation: row.processingOperation,
          attempts: row.attempts,
          leaseLockedAt,
        };
      }

      if (
        row.processingGeneration !== null ||
        row.processingOperation !== null ||
        row.lockedAt !== null
      ) {
        return null;
      }

      const desiredOperation = await this.readDesiredOperation(tx, circle, row);
      if (desiredOperation !== row.operation) {
        await enqueueCircleMemberSync(tx, desiredOperation, row.groupID, [
          row.userID,
        ]);
        return null;
      }

      const claimed = await tx.groupSyncOutbox.updateMany({
        where: {
          id: row.id,
          generation: row.generation,
          operation: row.operation,
          status: row.status,
          processingGeneration: null,
          processingOperation: null,
          lockedAt: null,
        },
        data: {
          processingGeneration: row.generation,
          processingOperation: row.operation,
          lockedAt: leaseLockedAt,
          status: 'PROCESSING',
        },
      });
      if (claimed.count === 0) return null;
      return {
        rowID: row.id,
        groupID: row.groupID,
        userID: row.userID,
        generation: row.generation,
        operation: row.operation,
        attempts: row.attempts,
        leaseLockedAt,
      };
    });
  }

  private async finalize(
    attempt: ClaimedAttempt,
    result: ExternalResult,
  ): Promise<void> {
    const circle = await this.findCircle(attempt.groupID);
    await runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockIfMapped(tx, circle, attempt.userID);
      const current = await tx.groupSyncOutbox.findUnique({
        where: { id: attempt.rowID },
        select: {
          generation: true,
          operation: true,
          processingGeneration: true,
          processingOperation: true,
          lockedAt: true,
        },
      });
      if (!current) return;

      const desiredChanged =
        current.generation !== attempt.generation ||
        current.operation !== attempt.operation;
      const where = {
        id: attempt.rowID,
        generation: current.generation,
        operation: current.operation,
        processingGeneration: attempt.generation,
        processingOperation: attempt.operation,
        lockedAt: attempt.leaseLockedAt,
      } as const;

      if (result.outcome === 'SUCCEEDED') {
        const finalized = await tx.groupSyncOutbox.updateMany({
          where,
          data: {
            processingGeneration: null,
            processingOperation: null,
            lockedAt: null,
            status: desiredChanged ? 'PENDING' : 'COMPLETED',
            nextAttemptAt: desiredChanged ? new Date() : undefined,
            processedAt: desiredChanged ? null : new Date(),
            lastError: null,
          },
        });
        if (finalized.count > 0 && result.idempotentMessage) {
          this.logger.warn(
            `OpenIM group sync outbox ${attempt.rowID} treated as completed: ${result.idempotentMessage}`,
          );
        }
        return;
      }

      const finalized = await tx.groupSyncOutbox.updateMany({
        where,
        data: desiredChanged
          ? {
              processingGeneration: null,
              processingOperation: null,
              lockedAt: null,
              status: 'PENDING',
              nextAttemptAt: new Date(),
            }
          : {
              processingGeneration: null,
              processingOperation: null,
              lockedAt: null,
              status: 'FAILED',
              attempts: { increment: 1 },
              lastError: result.message.slice(0, 1000),
              nextAttemptAt: this.nextRetryAt(attempt.attempts + 1),
            },
      });
      if (finalized.count > 0 && !desiredChanged) {
        this.logger.warn(
          `OpenIM group sync failed for outbox ${attempt.rowID}: ${result.message}`,
        );
      }
    });
  }

  private async applyExternalEffect(
    attempt: ClaimedAttempt,
  ): Promise<ExternalResult> {
    try {
      if (attempt.operation === 'ADD_MEMBER') {
        await this.openimService.addGroupMembers(attempt.groupID, [
          attempt.userID,
        ]);
      } else {
        await this.openimService.removeGroupMember(
          attempt.groupID,
          attempt.userID,
        );
      }
      return { outcome: 'SUCCEEDED' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isIdempotentOpenimResult(attempt.operation, message)) {
        return { outcome: 'SUCCEEDED', idempotentMessage: message };
      }
      return { outcome: 'FAILED', message };
    }
  }

  private async readDesiredOperation(
    tx: Prisma.TransactionClient,
    circle: CircleLookup,
    row: Pick<GroupSyncRow, 'groupID' | 'userID'>,
  ): Promise<GroupSyncOperation> {
    if (!circle) return 'REMOVE_MEMBER';

    const currentCircle = await tx.circle.findUnique({
      where: { id: circle.id },
      select: { groupID: true },
    });
    const membership = await tx.circleMember.findUnique({
      where: {
        userID_circleID: {
          userID: row.userID,
          circleID: circle.id,
        },
      },
      select: { status: true },
    });
    const mappingMatches =
      currentCircle !== null &&
      (currentCircle.groupID ?? circle.id) === row.groupID;
    return mappingMatches && membership?.status === 'ACTIVE'
      ? 'ADD_MEMBER'
      : 'REMOVE_MEMBER';
  }

  private async lockIfMapped(
    tx: Prisma.TransactionClient,
    circle: CircleLookup,
    userID: string,
  ): Promise<void> {
    if (circle) {
      await this.memberLock.lock(tx, circle.id, [userID]);
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
