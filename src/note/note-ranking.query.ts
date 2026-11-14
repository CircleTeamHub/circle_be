import { Prisma } from 'src/generated/prisma';

/**
 * 大众点评月榜（GET /note/ranking）：本月好评最多的笔记 id，排好序、截好条数。
 *
 * 计数只记在根笔记上（NoteRatingMonthly，按上海月份分桶，下个月没有行 = 归零），与
 * Note 之间没有外键关系，Prisma 的关系过滤用不上，所以写成原生 SQL：
 * - 只收原笔记（collectedFromNoteID IS NULL），收藏副本永远不上榜；
 * - 只收此刻上架且公开的（ACTIVE + available），与他人能打开的口径一致；
 * - 主人选了城市才上榜（全国榜也一样）：选城市就是主人的「参与榜单」；
 * - 排序 好评降序 → 差评升序 → 最近更新 → id，结果确定；排序与 LIMIT 都在库里做。
 *
 * 走迁移 20261113120000 的 (month, goodCount) 索引。真库回归见
 * test/postgres/note-ranking.pg-spec.ts。
 */
export function noteRankingQuery(params: {
  month: string;
  city: string | null;
  limit: number;
}): Prisma.Sql {
  const { month, city, limit } = params;
  const cityFilter =
    city === null
      ? Prisma.sql`n."city" IS NOT NULL`
      : Prisma.sql`n."city" = ${city}`;
  return Prisma.sql`
    SELECT n."id"
    FROM "NoteRatingMonthly" r
    JOIN "Note" n ON n."id" = r."noteID"
    WHERE r."month" = ${month}
      AND r."goodCount" > 0
      AND n."status" = 'ACTIVE'
      AND n."available" = true
      AND n."collectedFromNoteID" IS NULL
      AND ${cityFilter}
    ORDER BY r."goodCount" DESC, r."badCount" ASC, n."updatedAt" DESC, n."id" ASC
    LIMIT ${limit}
  `;
}
