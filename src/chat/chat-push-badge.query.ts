import { Prisma } from 'src/generated/prisma';
import { UNREAD_COUNT_CAP } from './chat.constants';

/**
 * G-18:这批收件人的全局未读总数(底数 = 已读与清空水位的更高者,不计自己发的、
 * 已删的、已撤回的)。口径与 app 内角标一致:免打扰会话不计 —— 否则每来一条推送,
 * iOS 图标上的数字都比 app 里看得见的大。
 *
 * 每个会话数到 UNREAD_COUNT_CAP 就停,和会话列表(loadUnreadCounts)同一个封顶:
 * app 的 tab 角标就是各会话封顶值之和。不封顶时一次查询的成本是「每个收件人所有
 * 未读消息条数之和」—— 越不看手机的人积压越大、推送也越频繁,活跃群每个合并窗口
 * (1s)都要为几百人回表几十万行。
 *
 * 没有任何未读的人不返回行(HAVING),推送照旧不带 badge 字段。
 */
export function unreadBadgeQuery(userIds: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT cm."userID", SUM(unread.count)::bigint AS count
    FROM "ChatMember" cm
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT 1
        FROM "ChatMessage" m
        WHERE m."conversationID" = cm."conversationID"
          AND m."height" > GREATEST(cm."lastReadHeight", cm."clearedBeforeHeight")
          AND m."deleted" = false
          AND (m."burnExpiresAt" IS NULL OR m."burnExpiresAt" > NOW())
          AND m."revokedAt" IS NULL
          AND (m."senderID" IS NULL OR m."senderID" <> cm."userID")
        LIMIT ${UNREAD_COUNT_CAP}
      ) AS capped
    ) AS unread
    WHERE cm."userID" = ANY(${userIds}::text[])
      AND cm."leftAt" IS NULL
      -- 隐藏的会话不出现在 GET /chat/conversations 里,自然也不进 app 的
      -- tab 未读数。这里不排掉的话,任何一条别的会话的推送都会把 iOS 角标
      -- 顶到一个比 app 里看得见的总数更大的值,而且每来一条推送就复现一次。
      AND cm."hiddenAt" IS NULL
      AND cm."muted" = false
    GROUP BY cm."userID"
    HAVING SUM(unread.count) > 0
  `;
}
