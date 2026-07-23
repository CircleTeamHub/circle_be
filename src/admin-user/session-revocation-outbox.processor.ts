import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SessionRevocationService } from 'src/auth/session-revocation.service';
import { PrismaService } from 'src/prisma/prisma.service';

const SESSION_REVOCATION_BATCH_SIZE = 100;
const SESSION_REVOCATION_MAX_BACKOFF_MS = 60 * 60 * 1000;
const REVOCATION_UNAVAILABLE =
  'Redis revocation or socket broadcast unavailable';

@Injectable()
export class SessionRevocationOutboxProcessor {
  private readonly logger = new Logger(SessionRevocationOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionRevocation: SessionRevocationService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processPending(): Promise<number> {
    const now = new Date();
    const jobs = await this.prisma.sessionRevocationOutbox.findMany({
      where: {
        OR: [{ nextAttemptAt: { lte: now } }, { expiresAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: SESSION_REVOCATION_BATCH_SIZE,
    });
    let completed = 0;

    for (const job of jobs) {
      if (job.expiresAt <= now) {
        const deleted = await this.prisma.sessionRevocationOutbox.deleteMany({
          where: { userID: job.userID, revokedAt: job.revokedAt },
        });
        completed += deleted.count;
        continue;
      }

      try {
        const revoked = await this.sessionRevocation.revokeUserAt(
          job.userID,
          job.revokedAt.getTime(),
        );
        if (!revoked) throw new Error(REVOCATION_UNAVAILABLE);

        const deleted = await this.prisma.sessionRevocationOutbox.deleteMany({
          where: { userID: job.userID, revokedAt: job.revokedAt },
        });
        completed += deleted.count;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.sessionRevocationOutbox.updateMany({
          where: { userID: job.userID, revokedAt: job.revokedAt },
          data: {
            attempts: { increment: 1 },
            lastError: message.slice(0, 1000),
            nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          },
        });
        this.logger.warn(`Session revocation retry failed: ${message}`);
      }
    }

    return completed;
  }

  private nextRetryAt(attempts: number): Date {
    const delayMs = Math.min(
      SESSION_REVOCATION_MAX_BACKOFF_MS,
      60_000 * 2 ** Math.max(0, attempts - 1),
    );
    return new Date(Date.now() + delayMs);
  }
}
