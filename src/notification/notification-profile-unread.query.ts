import { Prisma } from 'src/generated/prisma';
import { PROFILE_NOTIFICATION_TYPES } from './notification.constants';

export type ProfileUnreadCountRow = { userId: string; count: number };

/**
 * 一批收件人各自的「系统通知」(PROFILE 域)未读数,一条语句。
 *
 * 口径与 RealtimeService.broadcastSystemNotificationUnread 的逐人 count 完全一致:
 * toUserID = 收件人 AND deleted = false AND read = false AND type IN (PROFILE 域)。
 * 只回有未读的收件人,缺席的按 0 算。
 *
 * 用在系统公告扇出:每批 500 个收件人,原来是逐人一条 count、50 路并发,一次 5 万人
 * 的公告要打 5 万条 count、扇出期间持续抢池连接。现在每批一条,走
 * Notification_unread_recipient_type_idx (toUserID, type) WHERE deleted = false AND read = false
 * 的 Index Only Scan。deleted / read 写成字面量而不是参数:部分索引的谓词要在规划期被证明。
 */
export function profileUnreadCountsByRecipientQuery(
  userIds: readonly string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT n."toUserID" AS "userId", count(*)::int AS "count"
    FROM "Notification" n
    WHERE n."toUserID" = ANY(${[...userIds]}::text[])
      AND n."deleted" = false
      AND n."read" = false
      AND n."type" = ANY(${[...PROFILE_NOTIFICATION_TYPES]}::"NotificationType"[])
    GROUP BY n."toUserID"
  `;
}
