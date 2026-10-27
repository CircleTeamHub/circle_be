import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma';
import { isRetryableTransactionError } from 'src/utils/prisma-tx';

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

  // 一天一次，放在用户时区的凌晨低峰：整表重算期间持有 like-counter-reconciliation
  // 独占锁，所有点赞/取消点赞都要等它，而它只修「点赞人被硬删」这一种漂移。
  // 此前误配成每小时，与上面的 daily 说明不一致。容器 TZ=UTC，所以显式按
  // Asia/Shanghai 取凌晨 4 点（UTC 04:00 是北京时间正午）。
  @TrackedCron(CronExpression.EVERY_DAY_AT_4AM, 'like_reconciliation', {
    timeZone: 'Asia/Shanghai',
  })
  async reconcileReceivedLikeCounts(): Promise<number> {
    for (let attempt = 0; attempt < SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('like-reconciliation-job', 0)) AS acquired
      `;
            if (!lock?.acquired) return 0;
            // 点赞/取消点赞持有这把锁的共享锁,只持几毫秒。用 try-lock 的话,只要
            // 04:00 有一笔点赞在途就整天跳过、而且和「没有漂移」分不出来;所以阻塞等锁,
            // 5 秒等不到就报错(TrackedCron 记一次失败),拿到后恢复默认,不影响下面的 UPDATE。
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            // 返回 void:必须走 $executeRaw,$queryRaw 反序列化不了 void 列(真库 P2010)。
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('like-counter-reconciliation', 0))`;
            await tx.$executeRaw`SET LOCAL lock_timeout = DEFAULT`;

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
        // 原生查询的序列化失败报 P2010,不是 P2034,统一走 isRetryableTransactionError。
        if (
          isRetryableTransactionError(error) &&
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
