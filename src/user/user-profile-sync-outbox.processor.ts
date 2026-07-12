import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import {
  OPENIM_REQUEST_TIMEOUT_MS,
  OpenimService,
} from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';

// A lease is recoverable only well after OpenIM's request deadline. This keeps
// crash recovery without allowing two live requests for one user to overlap.
const PROFILE_SYNC_LEASE_TIMEOUT_MS = Math.max(
  10 * 60 * 1000,
  OPENIM_REQUEST_TIMEOUT_MS * 2,
);

@Injectable()
export class UserProfileSyncOutboxProcessor {
  private readonly logger = new Logger(UserProfileSyncOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openim: OpenimService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processPending(): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROFILE_SYNC_LEASE_TIMEOUT_MS);
    const jobs = await this.prisma.userProfileSyncOutbox.findMany({
      where: {
        OR: [
          {
            status: 'PENDING',
            leaseToken: null,
            nextAttemptAt: { lte: now },
          },
          {
            status: 'FAILED',
            leaseToken: null,
            nextAttemptAt: { lte: now },
          },
          {
            status: 'PENDING',
            leaseToken: { not: null },
            lockedAt: { lt: staleBefore },
          },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    let completed = 0;
    for (const job of jobs) {
      const leaseToken = randomUUID();
      const claimNow = new Date();
      const claimed = await this.prisma.userProfileSyncOutbox.updateMany({
        where: {
          id: job.id,
          generation: job.generation,
          status: job.status,
          ...(job.leaseToken
            ? { leaseToken: job.leaseToken, lockedAt: job.lockedAt }
            : { leaseToken: null }),
        },
        data: {
          status: 'PROCESSING',
          leaseToken,
          lockedAt: claimNow,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) continue;
      if (await this.processClaimed(job, leaseToken)) {
        completed += 1;
      }
    }
    return completed;
  }

  private async processClaimed(
    job: { id: string; userID: string; generation: number; attempts: number },
    leaseToken: string,
  ): Promise<boolean> {
    let generation = job.generation;
    while (true) {
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: job.userID },
          select: { id: true, nickname: true, avatarUrl: true },
        });
        if (!user) {
          throw new Error(`Profile sync user ${job.userID} no longer exists`);
        }
        await this.openim.updateUserInfo(user.id, {
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
        });
        const finished = await this.prisma.userProfileSyncOutbox.updateMany({
          where: {
            id: job.id,
            generation,
            leaseToken,
            status: 'PROCESSING',
          },
          data: {
            status: 'COMPLETED',
            processedAt: new Date(),
            lockedAt: null,
            leaseToken: null,
            lastError: null,
          },
        });
        if (finished.count > 0) {
          return true;
        }

        const supersedingGeneration = await this.promoteSupersedingGeneration(
          job.id,
          leaseToken,
        );
        if (supersedingGeneration === null) return false;
        generation = supersedingGeneration;
      } catch (error) {
        const attempts = job.attempts + 1;
        const failed = await this.prisma.userProfileSyncOutbox.updateMany({
          where: {
            id: job.id,
            generation,
            leaseToken,
            status: 'PROCESSING',
          },
          data: {
            status: 'FAILED',
            lockedAt: null,
            leaseToken: null,
            lastError: error instanceof Error ? error.message : String(error),
            nextAttemptAt: new Date(
              Date.now() +
                Math.min(60 * 60 * 1000, 2 ** Math.min(attempts, 10) * 1000),
            ),
          },
        });
        if (failed.count === 0) {
          const supersedingGeneration = await this.promoteSupersedingGeneration(
            job.id,
            leaseToken,
          );
          if (supersedingGeneration !== null) {
            generation = supersedingGeneration;
            continue;
          }
        }
        this.logger.warn(`Profile sync job ${job.id} failed: ${error}`);
        return false;
      }
    }
  }

  private async promoteSupersedingGeneration(
    jobId: string,
    leaseToken: string,
  ): Promise<number | null> {
    while (true) {
      const superseding = await this.prisma.userProfileSyncOutbox.findUnique({
        where: { id: jobId },
        select: { generation: true, status: true, leaseToken: true },
      });
      if (
        !superseding ||
        superseding.leaseToken !== leaseToken ||
        superseding.status !== 'PENDING'
      ) {
        return null;
      }

      const promoted = await this.prisma.userProfileSyncOutbox.updateMany({
        where: {
          id: jobId,
          generation: superseding.generation,
          leaseToken,
          status: 'PENDING',
        },
        data: { status: 'PROCESSING', lockedAt: new Date() },
      });
      if (promoted.count > 0) return superseding.generation;
    }
  }
}
