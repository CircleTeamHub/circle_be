import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { TrackedCron } from 'src/metrics/tracked-cron.decorator';
import { AssistantService } from './assistant.service';
import type { InfoAlertPayload } from './assistant-subscription.service';

const JOB_BATCH_SIZE = 50;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

type DeliveryJob = {
  id: string;
  userID: string;
  dedupeKey: string;
  status: 'PENDING' | 'PROCESSING' | 'FAILED';
  attempts: number;
  lockedAt: Date | null;
  nextAttemptAt: Date;
  payloadSnapshot: unknown;
};

@Injectable()
export class AssistantAlertDeliveryProcessor {
  private readonly logger = new Logger(AssistantAlertDeliveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assistant: AssistantService,
  ) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'assistant_alert_delivery')
  async processPending(): Promise<number> {
    return this.processJobs();
  }

  async processPendingForSource(sourceId: string): Promise<number> {
    return this.processJobs(sourceId);
  }

  private async processJobs(sourceId?: string): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const jobs = await this.prisma.assistantAlertDelivery.findMany({
      where: {
        ...(sourceId ? { sourceID: sourceId } : {}),
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: JOB_BATCH_SIZE,
    });

    let processed = 0;
    for (const job of jobs as DeliveryJob[]) {
      if (await this.processJob(job)) processed += 1;
    }
    return processed;
  }

  private async processJob(job: DeliveryJob): Promise<boolean> {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.assistantAlertDelivery.updateMany({
      where: {
        id: job.id,
        status: job.status,
        ...(job.status === 'PROCESSING' ? { lockedAt: job.lockedAt } : {}),
      },
      data: {
        status: 'PROCESSING',
        leaseToken,
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return false;

    try {
      const payload = this.parsePayload(job.payloadSnapshot);
      const message = await this.assistant.sendInfoAlert(
        job.userID,
        payload,
        job.dedupeKey,
      );
      const updated = await this.prisma.assistantAlertDelivery.updateMany({
        where: {
          id: job.id,
          status: 'PROCESSING',
          leaseToken,
        },
        data: {
          status: 'SENT',
          conversationID: message.conversationId,
          messageID: message.id,
          sentAt: new Date(),
          lockedAt: null,
          leaseToken: null,
          lastError: null,
        },
      });
      return updated.count > 0;
    } catch (error) {
      const failed = await this.prisma.assistantAlertDelivery.updateMany({
        where: {
          id: job.id,
          status: 'PROCESSING',
          leaseToken,
        },
        data: {
          status: 'FAILED',
          nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          lastError: this.errorCategory(error),
          lockedAt: null,
          leaseToken: null,
        },
      });
      if (failed.count > 0) {
        this.logger.warn({
          event: 'assistant_alert_delivery_failed',
          deliveryId: job.id,
          userId: job.userID,
          error: error instanceof Error ? error.name : 'unknown',
        });
        reportOperationalError(error, {
          component: 'AssistantAlertDeliveryProcessor',
          operation: 'processJob',
          kind: 'info-published',
        });
      }
      return false;
    }
  }

  private parsePayload(value: unknown): InfoAlertPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid assistant alert payload');
    }
    const payload = value as Partial<InfoAlertPayload>;
    if (
      payload.kind !== 'info-alert' ||
      typeof payload.alertKey !== 'string' ||
      typeof payload.sourceId !== 'string' ||
      typeof payload.title !== 'string' ||
      typeof payload.summary !== 'string' ||
      !payload.target ||
      payload.target.route !== 'plaza-post-detail' ||
      typeof payload.target.id !== 'string'
    ) {
      throw new Error('invalid assistant alert payload');
    }
    return payload as InfoAlertPayload;
  }

  private nextRetryAt(attempts: number): Date {
    return new Date(
      Date.now() +
        Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1)),
    );
  }

  private errorCategory(error: unknown): string {
    return error instanceof Error ? error.name.slice(0, 1000) : 'UnknownError';
  }
}
