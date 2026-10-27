import { Prisma } from 'src/generated/prisma';

/**
 * 按账号号码精确查找(大小写不敏感)ACTIVE 用户的 id。
 *
 * - `lower("accountId") = lower($1)` 命中函数式唯一索引 User_accountId_lower_key
 *   (迁移 20260623010000),最多一行。
 * - 不用 Prisma 的 `mode: 'insensitive'`:它编译成 ILIKE,用不上这个唯一索引,
 *   还会把输入里的 `_`、`%` 当通配符 —— `a_b` 能命中 `axb`,单个 `%` 能命中
 *   任意一个 ACTIVE 用户,等于一个绕过精确匹配的枚举口子。
 * - status 写成字面量:参数是 text,和枚举列直接比较会报 operator does not exist。
 */
export function activeUserIdByAccountIdQuery(accountId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE lower("accountId") = lower(${accountId})
      AND "status" = 'ACTIVE'
    LIMIT 1
  `;
}
