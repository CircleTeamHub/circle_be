import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * 清理死掉的 NoteShareLink 行（#94），镜像 RefreshTokenCleanup 的处置标准：
 * - `expiresAt < now`：链接永远无法再被解析；
 * - `revokedAt < now - RETENTION`：吊销已久，不再需要留作排障对账。
 *
 * `@@index([expiresAt])` 建模时就预留了这条清理路径，只是 cron 一直没写。
 * 每天低峰跑一次，硬删即可 —— 解析端对不存在/已过期/已吊销本就返回同一个
 * ShareLinkInvalid，删除不改变任何对外语义。
 */
@Injectable()
export class NoteShareLinkCleanup {
  private static readonly REVOKED_RETENTION_DAYS = 30;
  private readonly logger = new Logger(NoteShareLinkCleanup.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(now: Date = new Date()): Promise<void> {
    const revokedCutoff = new Date(
      now.getTime() -
        NoteShareLinkCleanup.REVOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      const removed = await this.prisma.noteShareLink.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { revokedAt: { lt: revokedCutoff } },
          ],
        },
      });
      if (removed.count > 0) {
        this.logger.log(`pruned ${removed.count} dead share link(s)`);
      }
    } catch (err) {
      // 清理失败只影响表体积，不影响业务；下一天的 cron 会重试。
      this.logger.error(
        'share link cleanup failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
