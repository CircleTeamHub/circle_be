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
  deletedNotesQuery,
  expiredUnlistedNotesQuery,
  type NoteCleanupCursor,
  type NoteCleanupRow,
} from './note-cleanup.query';
import { purgeDeletedNote } from './note-purge';
import { NOTE_UNLISTED_RETENTION_MS, NoteService } from './note.service';

/**
 * 笔记清理（2026-11 取消回收站后）：
 * 1. 下架（UNLISTED）满 60 天的笔记按主人删除处理 —— 标 DELETED 并广播给收藏者与聊天卡片；
 * 2. 全部已删除（DELETED）的笔记物理删除，不论删了多久：删除即永久，DELETED 只是
 *    「已对所有人消失、等这里删行」的中间态。每 10 分钟一轮。
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
    try {
      const expired = await this.drain(
        (after) =>
          expiredUnlistedNotesQuery({
            unlistedBefore,
            after,
            limit: NoteCleanup.BATCH_SIZE,
          }),
        (row) => this.notes.expireUnlistedNote(row, unlistedBefore),
      );
      // 第 1 步刚标成 DELETED 的这一轮就删掉。
      const purged = await this.drain(
        (after) => deletedNotesQuery({ after, limit: NoteCleanup.BATCH_SIZE }),
        (row) => purgeDeletedNote(this.prisma, row.id),
      );
      if (expired.failed + purged.failed > 0) reportHandledJobFailure();
      if (expired.done + purged.done > 0) {
        this.logger.log(
          `expired ${expired.done} unlisted note(s), purged ${purged.done} deleted note(s)`,
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
