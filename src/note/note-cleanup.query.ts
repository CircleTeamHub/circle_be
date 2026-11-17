import { Prisma } from 'src/generated/prisma';

/** 一批待清理的笔记；cursorAt 是这条查询的排序时间列，供键集翻页。 */
export type NoteCleanupRow = {
  id: string;
  ownerID: string;
  rootSourceNoteID: string | null;
  cursorAt: Date;
};

export type NoteCleanupCursor = { at: Date; id: string };

/**
 * NoteCleanup 的两条候选查询，都按 (时间, id) 键集翻页：某一行处理失败只跳过它、
 * 下一轮再试，不会卡住整轮，也不会反复取到同一行。
 *
 * 两条都落在部分索引上，前提是 "status" 写成 SQL 字面量、与索引谓词一字不差
 * （Prisma 的 findMany 会把枚举参数化成 CAST($n::text AS "NoteStatus")，部分索引用不上）。
 * 改这里就必须同步改迁移；真库回归见 test/postgres/note-cleanup.pg-spec.ts。
 */

/**
 * 回收站到期：删进回收站（DELETED）早于截止时间的笔记。删除时刻就是 updatedAt —— DELETED
 * 行没有别的写路径（所有写口都带 status <> DELETED 守卫，恢复则直接把状态改回去离开回收站，
 * 收录链改指向用原生 UPDATE 不碰 updatedAt），所以计时不会被无关写动作续命，翻页过程中
 * 排序键也不变。索引：20261026000500 的 ("updatedAt", "id") WHERE status = 'DELETED'。
 */
export function expiredRecycleBinNotesQuery(params: {
  deletedBefore: Date;
  after?: NoteCleanupCursor;
  limit: number;
}): Prisma.Sql {
  const { deletedBefore, after, limit } = params;
  const keyset = after
    ? Prisma.sql`AND ("updatedAt", "id") > (${after.at}, ${after.id})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT "id", "ownerID", "rootSourceNoteID", "updatedAt" AS "cursorAt"
    FROM "Note"
    WHERE "status" = 'DELETED'
      AND "updatedAt" < ${deletedBefore}
      ${keyset}
    ORDER BY "updatedAt" ASC, "id" ASC
    LIMIT ${limit}
  `;
}

/** 下架时刻不晚于截止时间的笔记。索引：20261113130000 的 ("unlistedAt", "id") WHERE status = 'UNLISTED'。 */
export function expiredUnlistedNotesQuery(params: {
  unlistedBefore: Date;
  after?: NoteCleanupCursor;
  limit: number;
}): Prisma.Sql {
  const { unlistedBefore, after, limit } = params;
  const keyset = after
    ? Prisma.sql`AND ("unlistedAt", "id") > (${after.at}, ${after.id})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT "id", "ownerID", "rootSourceNoteID", "unlistedAt" AS "cursorAt"
    FROM "Note"
    WHERE "status" = 'UNLISTED'
      AND "unlistedAt" <= ${unlistedBefore}
      ${keyset}
    ORDER BY "unlistedAt" ASC, "id" ASC
    LIMIT ${limit}
  `;
}
