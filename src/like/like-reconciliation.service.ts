import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma';

const SERIALIZATION_RETRIES = 3;

/**
 * Repairs drift in the denormalized User.receivedLikeCount.
 *
 * like()/unlike() keep the counter exact transactionally, but it can still
 * drift in one case the write path can't catch: when a liker account is hard
 * deleted, the FK ON DELETE CASCADE removes their UserLike rows WITHOUT
 * decrementing the likee's counter. This daily job recomputes every counter
 * from the actual rows so a stale value can't keep a user falsely at the
 * 合作达人 (TOP_COLLABORATOR) threshold.
 */
@Injectable()
export class LikeReconciliationService {
  private readonly logger = new Logger(LikeReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async reconcileReceivedLikeCounts(): Promise<number> {
    for (let attempt = 0; attempt < SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('like-reconciliation-job', 0)) AS acquired
      `;
            if (!lock?.acquired) return 0;
            const [consistencyLock] = await tx.$queryRaw<
              Array<{ acquired: boolean }>
            >`SELECT pg_try_advisory_xact_lock(hashtextextended('like-counter-reconciliation', 0)) AS acquired`;
            if (!consistencyLock?.acquired) return 0;

            // Single set-based update: recompute the true count per user (LEFT JOIN so
            // users with zero likes settle to 0) and write back only the drifted rows.
            const updated = await tx.$executeRaw`
      UPDATE "User" u
      SET "receivedLikeCount" = sub.cnt
      FROM (
        SELECT u2.id AS id, COALESCE(COUNT(ul.id), 0)::int AS cnt
        FROM "User" u2
        LEFT JOIN "UserLike" ul ON ul."toUserID" = u2.id
        GROUP BY u2.id
      ) sub
      WHERE u.id = sub.id AND u."receivedLikeCount" <> sub.cnt
      `;

            if (updated > 0) {
              this.logger.warn(
                `Reconciled receivedLikeCount drift on ${updated} user(s).`,
              );
            }
            return updated;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 300_000,
          },
        );
      } catch (error) {
        if (
          (error as { code?: string }).code === 'P2034' &&
          attempt < SERIALIZATION_RETRIES - 1
        ) {
          continue;
        }
        throw error;
      }
    }
    return 0;
  }
}
