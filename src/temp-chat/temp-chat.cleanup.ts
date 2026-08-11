import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { TempChatStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { TempChatService } from './temp-chat.service';
import { reportOperationalError } from 'src/logging/error-aggregation.service';

/** 单轮处理的房间数上限。剩余的留给下一轮,不在一次 sweep 里跑完。 */
const SWEEP_BATCH = 200;
/** 一次 sweep 最多连做几批,防止持续到期的房间把这一轮拖到下个 cron 头上。 */
const SWEEP_MAX_BATCHES = 5;

@Injectable()
export class TempChatCleanup {
  private readonly logger = new Logger(TempChatCleanup.name);
  /**
   * 重入闸。@Cron 到点就调,不管上一次有没有返回 —— 一次 sweep 跑过一分钟,
   * 第二次就会叠上来,两轮各自做一遍无界全表扫描。
   */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: TempChatService,
  ) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'temp_chat_cleanup')
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
        const due = await this.claimBatch();
        if (due.length === 0) return;
        for (const room of due) {
          try {
            await this.service.teardown(room, TempChatStatus.EXPIRED);
          } catch (err) {
            reportOperationalError(err, {
              component: 'TempChatCleanup',
              operation: 'teardownExpiredRoom',
              kind: 'scheduler',
            });
            this.logger.error(`teardown failed for ${room.id}: ${String(err)}`);
          }
        }
        // 取满说明还有剩余;没取满就是已经排空了。
        if (due.length < SWEEP_BATCH) return;
      }
      // 连做 SWEEP_MAX_BATCHES 批仍未排空:说明到期量级异常,记一条,
      // 剩下的下一轮继续 —— 静默截断会让人以为已经清干净了。
      this.logger.warn(
        `temp chat sweep hit the ${SWEEP_BATCH * SWEEP_MAX_BATCHES}-room cap; remainder deferred to the next tick`,
      );
    } catch (error) {
      reportOperationalError(error, {
        component: 'TempChatCleanup',
        operation: 'claimBatch',
        kind: 'scheduler',
      });
      this.logger.error(
        `temp chat batch claim failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * 一批待清理的房间,按 expiresAt 升序 —— 原来无排序无分页地把**全部**到期房间
   * 一次 findMany 进内存:房间上限是按主机算的、TTL 又普遍相同,一次大批量到期
   * 就能让单轮 sweep 跑过一分钟。有序 + 分批之后,最老的房间一定先被清掉,
   * 不会出现「每轮都在处理同一批、排在后面的永远轮不到」。
   */
  private claimBatch(): Promise<Array<{ id: string; groupId: string }>> {
    const now = new Date();
    const staleLeaseBefore = new Date(now.getTime() - 2 * 60 * 1000);
    return this.prisma.tempChat.findMany({
      where: {
        OR: [
          {
            status: TempChatStatus.ACTIVE,
            expiresAt: { lte: now },
          },
          {
            status: { in: [TempChatStatus.ENDED, TempChatStatus.EXPIRED] },
            cleanupCompletedAt: null,
            OR: [
              { cleanupLockedAt: null },
              { cleanupLockedAt: { lt: staleLeaseBefore } },
            ],
          },
        ],
      },
      orderBy: { expiresAt: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true, groupId: true },
    });
  }
}
