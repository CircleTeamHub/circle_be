import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CallService } from './call.service';
import { reportOperationalError } from '../logging/error-aggregation.service';

@Injectable()
export class CallCleanup {
  private readonly logger = new Logger(CallCleanup.name);

  constructor(private readonly callService: CallService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepExpiredRingingCalls(): Promise<void> {
    try {
      await this.callService.sweepExpiredRingingCalls();
    } catch (error) {
      reportOperationalError(error, {
        component: 'CallCleanup',
        operation: 'sweepExpiredRingingCalls',
        kind: 'scheduler',
      });
      this.logger.error(
        `expired ringing call cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
