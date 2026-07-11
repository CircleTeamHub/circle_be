import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';

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
    const staleBefore = new Date(now.getTime() - 10 * 60 * 1000);
    const jobs = await this.prisma.userProfileSyncOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
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
          ...(job.status === 'PROCESSING'
            ? { lockedAt: job.lockedAt }
            : {}),
        },
        data: {
          status: 'PROCESSING',
          leaseToken,
          lockedAt: claimNow,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) continue;
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
            generation: job.generation,
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
        if (finished.count > 0) completed += 1;
      } catch (error) {
        const attempts = job.attempts + 1;
        await this.prisma.userProfileSyncOutbox.updateMany({
          where: {
            id: job.id,
            generation: job.generation,
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
        this.logger.warn(`Profile sync job ${job.id} failed: ${error}`);
      }
    }
    return completed;
  }
}
