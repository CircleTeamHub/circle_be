import { Prisma, type NotificationType } from 'src/generated/prisma';

export type NotificationPageScan = {
  userId: string;
  types: readonly NotificationType[];
  limit: number;
  /** 游标模式：从这个 (createdAt, id) 之后接着翻。 */
  before?: { createdAt: Date; id: string };
  /** 老分页（返回数组）的 OFFSET；0 / 缺省不加。 */
  offset?: number;
};

/**
 * 通知列表一页的 id 扫描（首页、老分页、游标页共用），关系与本表列再按 id 回填。
 *
 * 只取 id / createdAt：Notification_active_recipient_created_type_idx
 * (toUserID, createdAt DESC, id DESC, type) WHERE deleted = false 自己就能回答
 * （Index Only Scan），type 的过滤在索引元组上做，不必为不匹配的行回表。
 * PostgreSQL 16 对非首列的 IN 列表不会当成有序索引条件，取整行时 type 只能回表
 * 判断 —— 大号打开「系统通知」（只要 SYSTEM）要把 90 天的行逐一回表。
 *
 * deleted = false 必须是字面量：部分索引谓词要在规划时被证明。
 */
export function notificationPageScanQuery(
  scan: NotificationPageScan,
): Prisma.Sql {
  return Prisma.sql`
    SELECT n."id", n."createdAt"
    FROM "Notification" n
    WHERE n."toUserID" = ${scan.userId}
      AND n."deleted" = false
      AND n."type" IN (${Prisma.join([...scan.types])})
      ${
        scan.before
          ? Prisma.sql`AND (n."createdAt", n."id") < (${scan.before.createdAt}, ${scan.before.id})`
          : Prisma.empty
      }
    ORDER BY n."createdAt" DESC, n."id" DESC
    LIMIT ${scan.limit}
    ${scan.offset ? Prisma.sql`OFFSET ${scan.offset}` : Prisma.empty}
  `;
}
