import { Prisma, type NotificationType } from 'src/generated/prisma';
import {
  CIRCLE_NOTIFICATION_TYPES,
  DISCOVER_NOTIFICATION_TYPES,
  MOMENT_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from './notification.constants';

export type UnreadNotificationCountRow = {
  type: NotificationType | string;
  count: number;
};

export type UnreadNotificationsByDomain = {
  discoverUnread: number;
  momentsUnread: number;
  circleUnread: number;
  profileUnread: number;
};

/**
 * 一个收件人每种通知类型的未读数，一条语句。
 *
 * 之前每个域各发一条 `count(*) ... type IN (...)`：未读汇总 4 条、徽标快照 4 条、
 * 每次新通知触发的 interaction 广播 3 条，全用 Promise.all 并发 —— 一次请求同时占
 * 3~4 个池连接，扫的还是同一段索引。现在只扫一遍
 * Notification_unread_recipient_type_idx (toUserID, type) WHERE deleted=false AND read=false，
 * 按类型分组，域的求和放到 JS（sumUnreadNotificationsByDomain）。
 *
 * deleted / read 写成字面量而不是参数：部分索引的谓词要在规划时被证明，参数化之后
 * 一旦走通用计划就证明不了，会退回扫全表。
 */
export function unreadNotificationCountsByTypeQuery(
  userId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT n."type"::text AS "type", count(*)::int AS "count"
    FROM "Notification" n
    WHERE n."toUserID" = ${userId}
      AND n."deleted" = false
      AND n."read" = false
    GROUP BY n."type"
  `;
}

const DOMAIN_TYPES: ReadonlyArray<
  [keyof UnreadNotificationsByDomain, ReadonlySet<string>]
> = [
  ['discoverUnread', new Set(DISCOVER_NOTIFICATION_TYPES)],
  ['momentsUnread', new Set(MOMENT_NOTIFICATION_TYPES)],
  ['circleUnread', new Set(CIRCLE_NOTIFICATION_TYPES)],
  ['profileUnread', new Set(PROFILE_NOTIFICATION_TYPES)],
];

/**
 * 按域求和，口径与原来每个域一条 `type IN (<该域类型>)` 的 count 完全一致：
 * 一种类型可以同时计进多个域（例如 TRACE_LIKE 既在互动总数也在朋友圈铃铛），
 * 不属于任何域的类型（报名、好友留言等）哪个域都不计。
 */
export function sumUnreadNotificationsByDomain(
  rows: readonly UnreadNotificationCountRow[],
): UnreadNotificationsByDomain {
  const totals: UnreadNotificationsByDomain = {
    discoverUnread: 0,
    momentsUnread: 0,
    circleUnread: 0,
    profileUnread: 0,
  };
  for (const row of rows) {
    const count = Number(row.count);
    for (const [key, types] of DOMAIN_TYPES) {
      if (types.has(row.type)) totals[key] += count;
    }
  }
  return totals;
}

export async function loadUnreadNotificationsByDomain(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
): Promise<UnreadNotificationsByDomain> {
  const rows = await db.$queryRaw<UnreadNotificationCountRow[]>(
    unreadNotificationCountsByTypeQuery(userId),
  );
  return sumUnreadNotificationsByDomain(rows);
}
