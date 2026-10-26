import { Prisma } from 'src/generated/prisma';

/**
 * 每分钟清理任务要认领的房间,按 expiresAt 升序取前 limit 条:
 * - 到期还没收尾的 ACTIVE 房间 —— 走 (status, expiresAt) 索引;
 * - 已结束(ENDED/EXPIRED)、清理还没完成、且没人持有新鲜租约的房间 —— 走
 *   20261026000320 的部分索引(只收 cleanupCompletedAt IS NULL 的房间)。
 *
 * 原来是一条 `A OR B` 的 findMany:第二支没有能用的索引,TempChat 又从不删行,每分钟
 * 都要把全部历史房间扫一遍。现在两支各自按 expiresAt 取前 limit 条,外层合并后再按
 * expiresAt 取 limit 条 —— 两支互斥(status 不同),结果集合与顺序和原来一致。
 *
 * 状态必须写成字面量:参数化的 `CAST($1::text AS "TempChatStatus")` 走 enum_in
 * (STABLE),规划时折不成常量,部分索引的谓词就证明不了。
 * 时间参数由调用方给(和原来一样用应用时钟);列是 timestamp(3),按 UTC 墙钟比较。
 */
export function dueTempChatsQuery(
  now: Date,
  staleLeaseBefore: Date,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT due."id", due."groupId"
    FROM (
      (
        SELECT t."id", t."groupId", t."expiresAt"
        FROM "TempChat" AS t
        WHERE t."status" = 'ACTIVE'
          AND t."expiresAt" <= ${now}::timestamp
        ORDER BY t."expiresAt" ASC
        LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT t."id", t."groupId", t."expiresAt"
        FROM "TempChat" AS t
        WHERE t."status" IN ('ENDED', 'EXPIRED')
          AND t."cleanupCompletedAt" IS NULL
          AND (t."cleanupLockedAt" IS NULL OR t."cleanupLockedAt" < ${staleLeaseBefore}::timestamp)
        ORDER BY t."expiresAt" ASC
        LIMIT ${limit}
      )
    ) AS due
    ORDER BY due."expiresAt" ASC
    LIMIT ${limit}
  `;
}
