import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { FancyNumberService } from './fancy-number.service';

@Injectable()
export class FancyNumberCleanup {
  constructor(private readonly service: FancyNumberService) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'fancy_number_lease_sweep')
  async sweepExpiredLeases(): Promise<void> {
    await this.service.expireDue();
  }
}
