import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  mapNotificationRealtimeDto,
  NOTIFICATION_REALTIME_INCLUDE,
} from './notification.dto';
import { NotificationPushService } from './notification-push.service';

const BATCH_SIZE = 100;
const STALE_LOCK_MS = 10 * 60 * 1000;

@Injectable()
export class NotificationPushOutboxProcessor {
  private readonly logger = new Logger(NotificationPushOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: NotificationPushService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processPending(): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const jobs = await this.prisma.notificationPushOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      include: { notification: { include: NOTIFICATION_REALTIME_INCLUDE } },
    });
    let processed = 0;
    for (const job of jobs) {
      const claimNow = new Date();
      const claimStaleBefore = new Date(claimNow.getTime() - STALE_LOCK_MS);
      const leaseToken = randomUUID();
      const claimed = await this.prisma.notificationPushOutbox.updateMany({
        where: {
          id: job.id,
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', nextAttemptAt: { lte: claimNow } },
            {
              status: 'PROCESSING',
              lockedAt: { lt: claimStaleBefore },
            },
          ],
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
        const delivery = await this.pushService.sendNotification(
          job.notification.toUserID ?? '',
          mapNotificationRealtimeDto(job.notification),
        );
        if (delivery.status === 'RETRYABLE_FAILURE') {
          throw new Error(delivery.error || 'Expo push delivery failed');
        }
        if (delivery.status === 'TERMINAL_FAILURE') {
          await this.prisma.notificationPushOutbox.updateMany({
            where: { id: job.id, leaseToken, status: 'PROCESSING' },
            data: {
              status: 'TERMINAL',
              processedAt: new Date(),
              lockedAt: null,
              leaseToken: null,
              lastError: (
                delivery.error || 'Terminal Expo ticket failure'
              ).slice(0, 1000),
            },
          });
          continue;
        }
        const finished = await this.prisma.notificationPushOutbox.updateMany({
          where: { id: job.id, leaseToken, status: 'PROCESSING' },
          data: {
            status: 'COMPLETED',
            processedAt: new Date(),
            lockedAt: null,
            leaseToken: null,
            lastError: null,
          },
        });
        if (finished.count > 0) processed += 1;
      } catch (error) {
        const attempts = job.attempts + 1;
        await this.prisma.notificationPushOutbox.updateMany({
          where: { id: job.id, leaseToken, status: 'PROCESSING' },
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
        this.logger.warn(`Push outbox job ${job.id} failed: ${error}`);
      }
    }
    return processed;
  }
}
