import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import { sanitizeLogValue } from 'src/logging/log-sanitizer';

/**
 * Prunes dead RefreshToken rows so the table doesn't grow unbounded (F-09).
 *
 * Two disposal criteria, both safe to hard-delete:
 * - `expiredAt < now`: the token can never authenticate again.
 * - `revokedAt < now - RETENTION`: revoked long enough ago that it's no longer
 *   useful for reuse-detection forensics (the reuse check only matters within a
 *   token's own validity window).
 *
 * Runs daily off-peak in bounded batches. Notification / FriendActivity
 * retention is intentionally left out — pruning user-visible history is a
 * product decision, not housekeeping.
 */
@Injectable()
export class RefreshTokenCleanup {
  private static readonly REVOKED_RETENTION_DAYS = 30;
  private static readonly BATCH_SIZE = 1000;
  private static readonly MAX_BATCHES_PER_RUN = 20;
  private readonly logger = new Logger(RefreshTokenCleanup.name);

  constructor(private readonly prisma: PrismaService) {}

  @TrackedCron(CronExpression.EVERY_DAY_AT_4AM, 'refresh_token_cleanup')
  async sweep(now: Date = new Date()): Promise<void> {
    const revokedCutoff = new Date(
      now.getTime() -
        RefreshTokenCleanup.REVOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const staleWhere = {
      OR: [{ expiredAt: { lt: now } }, { revokedAt: { lt: revokedCutoff } }],
    } satisfies Prisma.RefreshTokenWhereInput;
    let count = 0;
    try {
      for (
        let batch = 0;
        batch < RefreshTokenCleanup.MAX_BATCHES_PER_RUN;
        batch += 1
      ) {
        const candidates = await this.prisma.refreshToken.findMany({
          where: staleWhere,
          select: { id: true },
          orderBy: { id: 'asc' },
          take: RefreshTokenCleanup.BATCH_SIZE,
        });
        if (candidates.length === 0) break;

        // Recheck the retention predicate in the delete so a token refreshed
        // between the select and delete is never removed by a stale candidate.
        const deleted = await this.prisma.refreshToken.deleteMany({
          where: {
            AND: [staleWhere, { id: { in: candidates.map(({ id }) => id) } }],
          },
        });
        count += deleted.count;
        if (candidates.length < RefreshTokenCleanup.BATCH_SIZE) break;
      }
      if (count > 0) {
        this.logger.log(`Pruned ${count} expired/revoked refresh tokens`);
      }
    } catch (err) {
      reportOperationalError(err, {
        component: 'RefreshTokenCleanup',
        operation: 'sweep',
        kind: 'scheduler',
      });
      // Best-effort housekeeping: never let a prune failure crash the scheduler.
      this.logger.error(
        sanitizeLogValue({
          event: 'refresh_token_cleanup_failed',
          operation: 'sweep',
          error: err,
        }),
      );
      // 但要记成失败：不上报的话包装器会把这一轮算成成功，心跳照常前进。
      reportHandledJobFailure();
    }
  }
}
