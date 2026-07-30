import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FancyNumberService } from './fancy-number.service';

@Injectable()
export class FancyNumberCleanup {
  constructor(private readonly service: FancyNumberService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepExpiredLeases(): Promise<void> {
    await this.service.expireDue();
  }
}
