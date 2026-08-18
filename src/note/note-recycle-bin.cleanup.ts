import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * 回收站到期清理：软删（status=DELETED）满 30 天的笔记行硬删。
 *
 * 语义拍板（2026-08-16）：「下架」是长期仓库，永不自动删除；「回收站」才是
 * 有期限的缓冲带 —— 30 天内可恢复，到期清行。
 *
 * 只删 Postgres 行（NoteMedia / NoteGroupMembership 随外键级联）：
 * - MinIO 对象**必须**留下 —— collectNote 快照复制沿用原作者的 objectKey，
 *   同一对象可能被原件与任意多个收藏副本共享，按行删对象会打穿别人的笔记；
 * - 对象回收统一归 StorageAuditService「只报告、人工核对后再 GC」的路线，
 *   与删笔记/注销账号同一待遇。
 *
 * deletedAt 没有单列：软删除只改 status，@updatedAt 顶位即删除时刻。DELETED
 * 行没有别的写路径（所有写口都带 status != DELETED 守卫，restore 则直接把
 * 状态改回去离开回收站），所以 updatedAt 不会被无关写动作续命。
 */
@Injectable()
export class NoteRecycleBinCleanup {
  private static readonly RETENTION_DAYS = 30;
  private readonly logger = new Logger(NoteRecycleBinCleanup.name);

  constructor(private readonly prisma: PrismaService) {}

  @TrackedCron(CronExpression.EVERY_DAY_AT_4AM, 'note_recycle_bin_cleanup')
  async sweep(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(
      now.getTime() -
        NoteRecycleBinCleanup.RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      const removed = await this.prisma.note.deleteMany({
        where: { status: 'DELETED', updatedAt: { lt: cutoff } },
      });
      if (removed.count > 0) {
        this.logger.log(`purged ${removed.count} expired recycle-bin note(s)`);
      }
    } catch (err) {
      // 清理失败只影响表体积，不影响业务；下一天的 cron 会重试。
      this.logger.error(
        'recycle bin cleanup failed',
        err instanceof Error ? err.stack : String(err),
      );
      reportHandledJobFailure();
    }
  }
}
