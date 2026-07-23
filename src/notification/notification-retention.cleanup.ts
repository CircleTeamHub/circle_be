import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;
const DEFAULT_FRIEND_ACTIVITY_RETENTION_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 1_000;
const DELETE_BATCH_DELAY_MS = 100;
const MAX_TABLE_SWEEP_DURATION_MS = 15_000;

/**
 * Notification / FriendActivity 保留期清理（#95）。
 *
 * 两张表此前只增不减（refresh-token.cleanup 里明确注明是留给产品的决定）。
 * 默认值：通知 90 天（过季互动即噪音，徽标/未读只看近期）、好友动态 180 天
 * （「新的朋友」页有回溯价值）。都可用 env 覆盖；设 0 = 关闭该表清理，
 * 保守可回退 —— 这正是把「产品决定」做成配置而不是硬编码的原因。
 *
 * 已读/未读均删：留着一条 200 天前的未读通知只会让未读数永远不归零。
 * review 修复：不再单发全表 deleteMany —— 成熟表上那是一次顺序扫描 + 一个
 * 巨型删除事务（锁与 WAL 都不友好）。改为 createdAt 索引（见
 * 20260721170000_retention_createdat_indexes）+ 每批 1000 行的短事务删除，
 * 批间退让；本轮删不完由后续 cron 接力（保留期是天级语义，无需一次清完）。
 */
@Injectable()
export class NotificationRetentionCleanup {
  private readonly logger = new Logger(NotificationRetentionCleanup.name);
  private readonly notificationDays: number;
  private readonly friendActivityDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.notificationDays = this.readDays(
      config.get('NOTIFICATION_RETENTION_DAYS'),
      DEFAULT_NOTIFICATION_RETENTION_DAYS,
    );
    this.friendActivityDays = this.readDays(
      config.get('FRIEND_ACTIVITY_RETENTION_DAYS'),
      DEFAULT_FRIEND_ACTIVITY_RETENTION_DAYS,
    );
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep(now: Date = new Date()): Promise<void> {
    await this.runSweep(now);
  }

  private async runSweep(
    now: Date,
    db: Pick<PrismaService, '$executeRaw'> = this.prisma,
  ): Promise<void> {
    if (this.notificationDays > 0) {
      try {
        const cutoff = new Date(
          now.getTime() - this.notificationDays * MS_PER_DAY,
        );
        const removed = await this.batchedDelete(
          (take) =>
            db.$executeRaw`
            WITH expired AS (
              SELECT "id" FROM "Notification"
              WHERE "createdAt" < ${cutoff}
              ORDER BY "createdAt"
              LIMIT ${take}
              FOR UPDATE SKIP LOCKED
            )
            DELETE FROM "Notification" AS target
            USING expired
            WHERE target."id" = expired."id"`,
        );
        if (removed > 0) {
          this.logger.log(
            `pruned ${removed} notification(s) older than ${this.notificationDays}d`,
          );
        }
      } catch (err) {
        this.logger.error(
          'notification retention sweep failed',
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    if (this.friendActivityDays > 0) {
      try {
        const cutoff = new Date(
          now.getTime() - this.friendActivityDays * MS_PER_DAY,
        );
        const removed = await this.batchedDelete(
          (take) =>
            db.$executeRaw`
            WITH expired AS (
              SELECT "id" FROM "FriendActivity"
              WHERE "createdAt" < ${cutoff}
              ORDER BY "createdAt"
              LIMIT ${take}
              FOR UPDATE SKIP LOCKED
            )
            DELETE FROM "FriendActivity" AS target
            USING expired
            WHERE target."id" = expired."id"`,
        );
        if (removed > 0) {
          this.logger.log(
            `pruned ${removed} friend activity row(s) older than ${this.friendActivityDays}d`,
          );
        }
      } catch (err) {
        this.logger.error(
          'friend activity retention sweep failed',
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  /** 有界分批删除：每批一个短事务，批间退让；达到时间预算后由后续 cron 接力。 */
  private async batchedDelete(
    deleteBatch: (take: number) => Promise<number>,
  ): Promise<number> {
    const startedAt = Date.now();
    let total = 0;

    while (true) {
      const count = await deleteBatch(DELETE_BATCH_SIZE);
      total += count;
      if (
        count < DELETE_BATCH_SIZE ||
        Date.now() - startedAt >= MAX_TABLE_SWEEP_DURATION_MS
      ) {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, DELETE_BATCH_DELAY_MS),
      );
    }

    return total;
  }

  private readDays(raw: unknown, fallback: number): number {
    const parsed =
      typeof raw === 'string' ? Number.parseInt(raw, 10) : (raw as number);
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }
    return parsed;
  }
}
