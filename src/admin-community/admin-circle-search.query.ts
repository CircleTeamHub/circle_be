import { CircleAdminState, Prisma } from 'src/generated/prisma';

/**
 * 管理台圈子列表的关键词搜索(admin-community.service listCircles,search 非空时)。
 *
 * 原 Prisma 查询把「圈主账号/昵称」这支写成 OR 里的关系条件,Prisma 7 编译成
 * `Circle LEFT JOIN User ... WHERE (c.id ILIKE … OR c.name ILIKE … OR c.groupID ILIKE …
 * OR u.accountId ILIKE … OR u.nickname ILIKE …)`:OR 跨了两张表,哪支都用不上
 * trigram 索引,findMany 和 count 各做一遍 Circle × User 的整表 hash join。
 *
 * 这里改成「各个可索引的分支分别取 id,再 UNION」:圈子自身三列一支(三条 trigram
 * 可 BitmapOr),圈主一支(User 的两条 trigram,再按 Circle_ownerID_idx 回查)。
 * 只返回当前页的 id 和 total,行数据由调用方按 id 回查。
 *
 * 口径与原查询一致(真库逐页对照:test/postgres/admin-search-union.pg-spec.ts):
 * - Prisma 的 `contains + insensitive` 编译成 `ILIKE ('%' || $n || '%')`,不转义 % 和 _,
 *   这里照原样保留,不改变已有的匹配结果;
 * - status 过滤 adminState;排序 createdAt DESC, id DESC。
 */
export type CircleSearchFilter = {
  search: string;
  status?: CircleAdminState;
};

/** column 只接受本文件里写死的列名;search 走参数绑定。 */
const ilike = (column: string, search: string) =>
  Prisma.sql`${Prisma.raw(column)} ILIKE ('%' || ${search} || '%')`;

function circleSearchWhere({ search, status }: CircleSearchFilter) {
  const matching = Prisma.sql`
    SELECT own."id" FROM "Circle" own
    WHERE ${ilike('own."id"', search)}
       OR ${ilike('own."name"', search)}
       OR ${ilike('own."groupID"', search)}
    UNION
    SELECT owned."id" FROM "Circle" owned
    JOIN "User" u ON u."id" = owned."ownerID"
    WHERE ${ilike('u."accountId"', search)}
       OR ${ilike('u."nickname"', search)}`;
  const state = status
    ? Prisma.sql`AND c."adminState" = ${status}::"CircleAdminState"`
    : Prisma.empty;
  return Prisma.sql`WHERE c."id" IN (${matching}) ${state}`;
}

export function buildCircleSearchPageQuery(
  input: CircleSearchFilter & { limit: number; offset: number },
): Prisma.Sql {
  return Prisma.sql`
    SELECT c."id" FROM "Circle" c
    ${circleSearchWhere(input)}
    ORDER BY c."createdAt" DESC, c."id" DESC
    LIMIT ${input.limit} OFFSET ${input.offset}`;
}

export function buildCircleSearchCountQuery(
  input: CircleSearchFilter,
): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::int AS "total" FROM "Circle" c
    ${circleSearchWhere(input)}`;
}
