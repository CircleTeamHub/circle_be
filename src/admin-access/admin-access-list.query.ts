import { Prisma } from 'src/generated/prisma';

/**
 * 管理员列表(GET /admin/access)的分页与计数。
 *
 * 为什么不用 Prisma 的 findMany/count:Prisma 把枚举条件编译成
 * `"role" = CAST($1::text AS "UserRole")`。text → 枚举的转换走 enum_in(STABLE),
 * 规划期不会折叠成常量,部分索引 `WHERE "role" = 'ADMIN'` 的谓词证明就对不上,
 * 两条查询都只能整张 User 表顺序扫描(真库 EXPLAIN 已确认)。这里把两个固定条件
 * 写成 SQL 字面量,才能命中 20261026000420 里那条只收管理员的部分索引
 * "User_admin_createdAt_idx"。
 *
 * 筛选口径与原 Prisma 查询逐项一致(真库对照测试 test/postgres/index-admin-console.pg-spec.ts):
 * - role = ADMIN 且 status <> DELETED;
 * - search 非空时 accountId / nickname 不区分大小写子串匹配。Prisma 的
 *   `contains + insensitive` 编译成 `ILIKE ('%' || $n || '%')`,不转义 % 和 _,
 *   这里照原样保留,不改变已有的匹配结果;
 * - 排序 createdAt DESC, id DESC。
 */
export type AdminListRow = {
  id: string;
  accountId: string;
  nickname: string;
  status: string;
  consoleRole: string | null;
  version: number | null;
};

function adminListWhere(search: string | undefined): Prisma.Sql {
  const keyword = search
    ? Prisma.sql`AND (u."accountId" ILIKE ('%' || ${search} || '%') OR u."nickname" ILIKE ('%' || ${search} || '%'))`
    : Prisma.empty;
  return Prisma.sql`WHERE u."role" = 'ADMIN' AND u."status" <> 'DELETED' ${keyword}`;
}

export function buildAdminListPageQuery(input: {
  search?: string;
  limit: number;
  offset: number;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT u."id", u."accountId", u."nickname", u."status"::text AS "status",
      a."role"::text AS "consoleRole", a."version"
    FROM "User" u
    LEFT JOIN "AdminAccess" a ON a."userID" = u."id"
    ${adminListWhere(input.search)}
    ORDER BY u."createdAt" DESC, u."id" DESC
    LIMIT ${input.limit} OFFSET ${input.offset}`;
}

export function buildAdminListCountQuery(input: {
  search?: string;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::int AS "total"
    FROM "User" u
    ${adminListWhere(input.search)}`;
}
