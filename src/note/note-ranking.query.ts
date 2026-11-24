import { Prisma } from 'src/generated/prisma';
import type { NoteRankingBoard } from './dto/note.dto';

/**
 * 大众点评月榜（GET /note/ranking）：本月好评最多（好评榜）或差评最多（差评榜）的笔记 id，
 * 排好序、截好条数。
 *
 * 计数只记在根笔记上（NoteRatingMonthly，按上海月份分桶，下个月没有行 = 归零），与
 * Note 之间没有外键关系，Prisma 的关系过滤用不上，所以写成原生 SQL：
 * - 只收原笔记（collectedFromNoteID IS NULL），收藏副本永远不上榜；
 * - 只收此刻上架且公开的（ACTIVE + available），与他人能打开的口径一致；
 * - 全国榜不看城市；城市榜只收主人选了该城市的笔记；
 * - 好评榜：好评 > 0，排序 好评降序 → 差评升序 → 最近更新 → id；
 * - 差评榜：差评 > 0（零好评也上榜），排序 差评降序 → 好评升序 → 最近更新 → id；
 * - 结果确定；排序与 LIMIT 都在库里做。
 *
 * 两张榜都靠迁移 20261113120000 的 (month, goodCount) 索引按月份取行：一个月的计数行
 * 就是当月被评过的笔记，差评榜在这些行里过滤、排序，不另建 (month, badCount) 索引。
 * 真库回归见 test/postgres/note-ranking.pg-spec.ts。
 */
export function noteRankingQuery(params: {
  month: string;
  city: string | null;
  board: NoteRankingBoard;
  limit: number;
}): Prisma.Sql {
  const { month, city, board, limit } = params;
  const cityFilter =
    city === null ? Prisma.empty : Prisma.sql`AND n."city" = ${city}`;
  const [ranked, tiebreak] =
    board === 'bad'
      ? [Prisma.sql`r."badCount"`, Prisma.sql`r."goodCount"`]
      : [Prisma.sql`r."goodCount"`, Prisma.sql`r."badCount"`];
  return Prisma.sql`
    SELECT n."id"
    FROM "NoteRatingMonthly" r
    JOIN "Note" n ON n."id" = r."noteID"
    WHERE r."month" = ${month}
      AND ${ranked} > 0
      AND n."status" = 'ACTIVE'
      AND n."available" = true
      AND n."collectedFromNoteID" IS NULL
      ${cityFilter}
    ORDER BY ${ranked} DESC, ${tiebreak} ASC, n."updatedAt" DESC, n."id" ASC
    LIMIT ${limit}
  `;
}
