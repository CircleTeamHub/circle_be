import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;
const DEFAULT_FRIEND_ACTIVITY_RETENTION_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Notification / FriendActivity 保留期清理（#95）。
 *
 * 两张表此前只增不减（refresh-token.cleanup 里明确注明是留给产品的决定）。
 * 默认值：通知 90 天（过季互动即噪音，徽标/未读只看近期）、好友动态 180 天
 * （「新的朋友」页有回溯价值）。都可用 env 覆盖；设 0 = 关闭该表清理，
 * 保守可回退 —— 这正是把「产品决定」做成配置而不是硬编码的原因。
 *
 * 已读/未读均删：留着一条 200 天前的未读通知只会让未读数永远不归零。
 * 每日低峰全量 delete 即可（镜像 refresh-token.cleanup / share-link cleanup）。
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

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(now: Date = new Date()): Promise<void> {
    if (this.notificationDays > 0) {
      try {
        const removed = await this.prisma.notification.deleteMany({
          where: {
            createdAt: {
              lt: new Date(now.getTime() - this.notificationDays * MS_PER_DAY),
            },
          },
        });
        if (removed.count > 0) {
          this.logger.log(
            `pruned ${removed.count} notification(s) older than ${this.notificationDays}d`,
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
        const removed = await this.prisma.friendActivity.deleteMany({
          where: {
            createdAt: {
              lt: new Date(
                now.getTime() - this.friendActivityDays * MS_PER_DAY,
              ),
            },
          },
        });
        if (removed.count > 0) {
          this.logger.log(
            `pruned ${removed.count} friend activity row(s) older than ${this.friendActivityDays}d`,
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

  private readDays(raw: unknown, fallback: number): number {
    const parsed =
      typeof raw === 'string' ? Number.parseInt(raw, 10) : (raw as number);
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }
    return parsed;
  }
}
