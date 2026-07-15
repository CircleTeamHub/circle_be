import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Prunes dead RefreshToken rows so the table doesn't grow unbounded (F-09).
 *
 * Two disposal criteria, both safe to hard-delete:
 * - `expiredAt < now`: the token can never authenticate again.
 * - `revokedAt < now - RETENTION`: revoked long enough ago that it's no longer
 *   useful for reuse-detection forensics (the reuse check only matters within a
 *   token's own validity window).
 *
 * Runs daily off-peak; a full delete is fine at this cadence. Notification /
 * FriendActivity retention is intentionally left out — pruning user-visible
 * history is a product decision, not housekeeping.
 */
@Injectable()
export class RefreshTokenCleanup {
  private static readonly REVOKED_RETENTION_DAYS = 30;
  private readonly logger = new Logger(RefreshTokenCleanup.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(now: Date = new Date()): Promise<void> {
    const revokedCutoff = new Date(
      now.getTime() -
        RefreshTokenCleanup.REVOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      const { count } = await this.prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiredAt: { lt: now } },
            { revokedAt: { lt: revokedCutoff } },
          ],
        },
      });
      if (count > 0) {
        this.logger.log(`Pruned ${count} expired/revoked refresh tokens`);
      }
    } catch (err) {
      // Best-effort housekeeping: never let a prune failure crash the scheduler.
      this.logger.error(`Refresh-token prune failed: ${String(err)}`);
    }
  }
}
