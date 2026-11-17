import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { Prisma } from 'src/generated/prisma';
import {
  reportHandledJobFailure,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { prismaErrorCode } from 'src/utils/prisma-tx';
import {
  expiredRecycleBinNotesQuery,
  expiredUnlistedNotesQuery,
  type NoteCleanupCursor,
  type NoteCleanupRow,
} from './note-cleanup.query';
import { purgeDeletedNote } from './note-purge';
import {
  NOTE_RECYCLE_BIN_RETENTION_MS,
  NOTE_UNLISTED_RETENTION_MS,
  NoteService,
} from './note.service';

/**
 * 笔记清理，每 10 分钟一轮，两种到期各归这里一处：
 * 1. 下架（UNLISTED）满 60 天的笔记永久删除 —— 先标 DELETED 并广播给收藏者与聊天卡片，
 *    再当场删行，不进回收站（60 天就是期限，不再多给 30 天）；
 * 2. 回收站（DELETED）里删除满 30 天的笔记永久删除。30 天内主人可在回收站恢复或
 *    「立即删除」（NoteService.restoreNote / purgeNote）。
 *
 * 删行走 purgeDeletedNote（含收录链改指向），只删 Postgres 行：MinIO 对象**必须**留下 ——
 * collectNote 快照复制沿用原作者的 objectKey，同一对象可能被原件与任意多个收藏副本共享，
 * 对象回收归 StorageAuditService「只报告、人工核对后再 GC」的路线。
 */
@Injectable()
export class NoteCleanup {
  private static readonly BATCH_SIZE = 200;
  private readonly logger = new Logger(NoteCleanup.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notes: NoteService,
  ) {}

  @TrackedCron(CronExpression.EVERY_10_MINUTES, 'note_cleanup')
  async sweep(now: Date = new Date()): Promise<void> {
    const unlistedBefore = new Date(now.getTime() - NOTE_UNLISTED_RETENTION_MS);
    const deletedBefore = new Date(
      now.getTime() - NOTE_RECYCLE_BIN_RETENTION_MS,
    );
    try {
      const expired = await this.drain(
        (after) =>
          expiredUnlistedNotesQuery({
            unlistedBefore,
            after,
            limit: NoteCleanup.BATCH_SIZE,
          }),
        // 标记成功就以主人的名义当场删行（同回收站「立即删除」的守卫）。删行失败的
        // 留在回收站里，30 天到期再删。
        async (row) =>
          (await this.notes.expireUnlistedNote(row, unlistedBefore)) &&
          purgeDeletedNote(this.prisma, row.id, { ownerID: row.ownerID }),
      );
      const purged = await this.drain(
        (after) =>
          expiredRecycleBinNotesQuery({
            deletedBefore,
            after,
            limit: NoteCleanup.BATCH_SIZE,
          }),
        // 删除时按同一截止时间复核：查出候选后被恢复、又删进回收站的不动。
        (row) => purgeDeletedNote(this.prisma, row.id, { deletedBefore }),
      );
      if (expired.failed + purged.failed > 0) reportHandledJobFailure();
      if (expired.done + purged.done > 0) {
        this.logger.log(
          `expired ${expired.done} unlisted note(s), purged ${purged.done} recycle-bin note(s)`,
        );
      }
    } catch (err) {
      // 清理失败只是晚删；下一轮 cron 会重试。
      this.logger.error(
        'note cleanup failed',
        err instanceof Error ? err.stack : String(err),
      );
      reportHandledJobFailure();
    }
  }

  /** 逐行处理一条候选查询的全部结果；失败的行跳过（键集在它之后继续）。 */
  private async drain(
    page: (after?: NoteCleanupCursor) => Prisma.Sql,
    handle: (row: NoteCleanupRow) => Promise<boolean>,
  ): Promise<{ done: number; failed: number }> {
    let done = 0;
    let failed = 0;
    let after: NoteCleanupCursor | undefined;
    for (;;) {
      const batch = await this.prisma.$queryRaw<NoteCleanupRow[]>(page(after));
      for (const row of batch) {
        try {
          if (await handle(row)) done += 1;
        } catch (err) {
          failed += 1;
          // 只记错误码：Prisma 的报错正文可能带唯一键里的用户 id。
          this.logger.warn(
            `note cleanup skipped one note (${prismaErrorCode(err) ?? 'unknown'})`,
          );
        }
      }
      if (batch.length < NoteCleanup.BATCH_SIZE) break;
      const last = batch[batch.length - 1];
      after = { at: last.cursorAt, id: last.id };
    }
    return { done, failed };
  }
}
