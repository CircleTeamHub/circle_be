import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { prismaErrorCode } from 'src/utils/prisma-tx';
import { purgeDeletedNote } from './note-purge';

/**
 * 回收站到期清理：软删（status=DELETED）满 30 天的笔记行硬删。
 *
 * 语义拍板（2026-08-16）：「下架」是长期仓库，永不自动删除；「回收站」才是
 * 有期限的缓冲带 —— 30 天内可恢复，到期清行。
 *
 * 删除本身走 purgeDeletedNote（与回收站「立即删除」共用，含收录链改指向）。
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
  private static readonly BATCH_SIZE = 200;
  private readonly logger = new Logger(NoteRecycleBinCleanup.name);

  constructor(private readonly prisma: PrismaService) {}

  @TrackedCron(CronExpression.EVERY_DAY_AT_4AM, 'note_recycle_bin_cleanup')
  async sweep(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(
      now.getTime() -
        NoteRecycleBinCleanup.RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      // 逐行删：每行要先把收录链下游改指向它的上游（见 purgeDeletedNote），
      // 一条 deleteMany 做不到。处理顺序无关：改指向时读的是上游的当前值。
      // 按 id 游标前进：某一行删失败（例如改指向撞唯一索引）只跳过它、明天再试，
      // 不会卡住整轮，也不会反复取到同一行。
      let purged = 0;
      let failed = 0;
      let after: string | undefined;
      for (;;) {
        const batch = await this.prisma.note.findMany({
          where: {
            status: 'DELETED',
            updatedAt: { lt: cutoff },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: NoteRecycleBinCleanup.BATCH_SIZE,
        });
        for (const { id } of batch) {
          try {
            if (
              await purgeDeletedNote(this.prisma, id, {
                deletedBefore: cutoff,
              })
            ) {
              purged += 1;
            }
          } catch (err) {
            failed += 1;
            // 只记错误码：Prisma 的报错正文可能带唯一键里的用户 id。
            this.logger.warn(
              `recycle bin purge skipped one note (${prismaErrorCode(err) ?? 'unknown'})`,
            );
          }
        }
        if (batch.length < NoteRecycleBinCleanup.BATCH_SIZE) break;
        after = batch[batch.length - 1].id;
      }
      if (failed > 0) reportHandledJobFailure();
      if (purged > 0) {
        this.logger.log(`purged ${purged} expired recycle-bin note(s)`);
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
