import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Repairs drift in the denormalized User.receivedLikeCount.
 *
 * like()/unlike() keep the counter exact transactionally, but it can still
 * drift in one case the write path can't catch: when a liker account is hard
 * deleted, the FK ON DELETE CASCADE removes their UserLike rows WITHOUT
 * decrementing the likee's counter. This daily job recomputes every counter
 * from the actual rows so a stale value can't keep a user falsely at the
 * 合作达人 (PARTNER) threshold.
 */
@Injectable()
export class LikeReconciliationService {
  private readonly logger = new Logger(LikeReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async reconcileReceivedLikeCounts(): Promise<number> {
    // Single set-based update: recompute the true count per user (LEFT JOIN so
    // users with zero likes settle to 0) and write back only the drifted rows.
    const updated = await this.prisma.$executeRaw`
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
  }
}
