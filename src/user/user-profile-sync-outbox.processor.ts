import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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
      include: {
        user: { select: { id: true, nickname: true, avatarUrl: true } },
      },
    });
    let completed = 0;
    for (const job of jobs) {
      const claimed = await this.prisma.userProfileSyncOutbox.updateMany({
        where: {
          id: job.id,
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', nextAttemptAt: { lte: now } },
            { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
          ],
        },
        data: {
          status: 'PROCESSING',
          lockedAt: now,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) continue;
      try {
        await this.openim.updateUserInfo(job.user.id, {
          nickname: job.user.nickname,
          avatarUrl: job.user.avatarUrl,
        });
        await this.prisma.userProfileSyncOutbox.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            processedAt: new Date(),
            lockedAt: null,
          },
        });
        completed += 1;
      } catch (error) {
        const attempts = job.attempts + 1;
        await this.prisma.userProfileSyncOutbox.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            lockedAt: null,
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
