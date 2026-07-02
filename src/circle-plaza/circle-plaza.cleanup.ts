import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CirclePlazaService } from './circle-plaza.service';

// Safety cap on batches drained per tick so a huge backlog can't make a single
// tick run unbounded. 50 batches * 100 posts = up to 5000 posts/tick.
const MAX_SWEEP_BATCHES_PER_TICK = 50;

@Injectable()
export class CirclePlazaCleanup {
  private readonly logger = new Logger(CirclePlazaCleanup.name);

  // Re-entrancy guard: if a tick is still draining when the next Cron fires
  // (or another @Cron instance overlaps in-process), skip rather than run two
  // sweeps concurrently.
  private running = false;

  constructor(private readonly service: CirclePlazaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepExpiredPosts(): Promise<void> {
    if (this.running) {
      this.logger.debug('expired circle post sweep already running; skipping');
      return;
    }
    this.running = true;
    try {
      // Drain full batches within one tick so a backlog (e.g. post-deploy
      // backfill) clears quickly instead of at 100 posts/minute. Stops as soon
      // as a batch comes back empty.
      for (let i = 0; i < MAX_SWEEP_BATCHES_PER_TICK; i++) {
        const { count } = await this.service.sweepExpiredPosts();
        if (count === 0) break;
      }
    } catch (error) {
      this.logger.error(
        `expired circle post cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
