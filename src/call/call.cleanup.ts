import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { CallService } from './call.service';
import { reportOperationalError } from '../logging/error-aggregation.service';

@Injectable()
export class CallCleanup {
  private readonly logger = new Logger(CallCleanup.name);

  constructor(private readonly callService: CallService) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'call_ringing_sweep')
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
