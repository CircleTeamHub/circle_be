import { Prisma } from 'src/generated/prisma';

/**
 * 回收站到期清理的一批候选：软删（status=DELETED）且 updatedAt 早于截止时间的笔记，
 * 按 (updatedAt, id) 键集翻页。
 *
 * 此前是 Prisma 的 findMany（where status/updatedAt/id>after，orderBy id，take 200）：
 * - status 被 Prisma 参数化成 CAST($n::text AS "NoteStatus")，规划期看不到值，任何
 *   带 status 谓词的部分索引都用不上；
 * - 按 id 排序，updatedAt 只能当过滤条件 —— 到期行稀疏时（每天删、每天清，到期的
 *   只是 30 天里的一天）要把整张 Note 表走完才凑够一批。
 *
 * 现在落在迁移 20261026000500 的部分索引 ("updatedAt", "id") WHERE "status" = 'DELETED'
 * 上：一次索引范围扫描，读到 LIMIT 条就停。能用上的前提是 "status" = 'DELETED' 写成
 * SQL 字面量，与索引谓词一字不差 —— 改这里就必须同步改迁移（真库回归
 * test/postgres/note-collect-chain-indexes.pg-spec.ts 会拦）。
 *
 * 键集用行比较 ("updatedAt", "id") > (上一批最后一行)：上一批里删除失败的行仍满足条件，
 * 但排在游标之前，不会被反复取到；同一时刻删的一批笔记 updatedAt 相同，靠 id 决出先后。
 * DELETED 行没有别的写路径（见 NoteRecycleBinCleanup 的说明），翻页过程中排序键不变。
 */
export function expiredRecycleBinNotesQuery(params: {
  cutoff: Date;
  after?: { updatedAt: Date; id: string };
  limit: number;
}): Prisma.Sql {
  const { cutoff, after, limit } = params;
  const keyset = after
    ? Prisma.sql`AND ("updatedAt", "id") > (${after.updatedAt}, ${after.id})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT "id", "updatedAt"
    FROM "Note"
    WHERE "status" = 'DELETED'
      AND "updatedAt" < ${cutoff}
      ${keyset}
    ORDER BY "updatedAt" ASC, "id" ASC
    LIMIT ${limit}
  `;
}
