import { Prisma } from 'src/generated/prisma';

/**
 * 「申请人和这个人私聊过」的口径 —— 候选名单与加席/投票的逐人判定共用这一段,
 * 两处不能各写一遍、各自漂移。
 *
 * - 只看 DIRECT 会话,群里同时出现不算。
 * - **双方都发过言**:申请人给圈里陌生人发一句「你好」不够,对方得回过话。
 *   自动回复(content.autoReply)是服务端代发的,不算对方发言。
 * - 以**申请人这边能搜到**为准,与全局搜索 / getHistory 同一把尺子:座位在
 *   (leftAt 为空)、清空水位之上(max(座位水位, 会话水位))、未删除、未撤回、
 *   未焚毁(burnExpiresAt 已过)。清空了的记录不再算数。
 * - 任一方向拉黑都不算。好友那一半不必管这条:拉黑会删掉好友行。
 *
 * 消息的 EXISTS 走 (conversationID, senderID, clientMessageId) 唯一索引的前缀。
 */
function mutualDirectChatPeerIdsSql(applicantId: string): Prisma.Sql {
  const visibleMessageFrom = (sender: Prisma.Sql) => Prisma.sql`
    SELECT 1
    FROM "ChatMessage" AS msg
    WHERE msg."conversationID" = conv."id"
      AND msg."senderID" = ${sender}
      AND msg."height" > GREATEST(mine."clearedBeforeHeight", conv."clearedBeforeHeight")
      AND msg."deleted" = false
      AND msg."revokedAt" IS NULL
      AND (msg."burnExpiresAt" IS NULL OR msg."burnExpiresAt" > now())
      AND (msg."content" ->> 'autoReply') IS DISTINCT FROM 'true'
  `;
  return Prisma.sql`
    SELECT peer."userID"
    FROM "ChatMember" AS mine
    JOIN "ChatConversation" AS conv ON conv."id" = mine."conversationID"
    JOIN "ChatMember" AS peer
      ON peer."conversationID" = mine."conversationID"
     AND peer."userID" <> mine."userID"
    WHERE mine."userID" = ${applicantId}
      AND mine."leftAt" IS NULL
      AND conv."type" = 'DIRECT'
      AND EXISTS (${visibleMessageFrom(Prisma.raw('mine."userID"'))})
      AND EXISTS (${visibleMessageFrom(Prisma.raw('peer."userID"'))})
      AND NOT EXISTS (
        SELECT 1
        FROM "Block" AS block
        WHERE (block."blockerID" = mine."userID" AND block."blockedID" = peer."userID")
           OR (block."blockerID" = peer."userID" AND block."blockedID" = mine."userID")
      )
  `;
}

/**
 * 申请人可挑的验证人 id = 本圈 ACTIVE 成员 ∩ (申请人的已接受好友 ∪ 和申请人私聊过的人)
 * − 排除名单（已占席的、申请人自己），按入圈先后（createdAt 升序）。
 *
 * 一条语句:关系集合是 IN 子查询(好友走 Friend 的 (userID, friendID) / (friendID, userID)
 * 索引,私聊走申请人的 ChatMember 座位),规划器先取出申请人的关系人、再按
 * (userID, circleID) 唯一索引逐个探测成员行,不把整圈成员搬到应用里。
 *
 * - 好友方向：friend 表一对好友只存一行，申请人可能在 userID 也可能在 friendID 一侧；
 *   CASE 取另一侧。同一个人既是好友又私聊过、或好友行重复时，IN 是半连接，结果天然不重。
 * - 排除名单「不看状态」，与 addVerifier 的 AlreadyVerifier 判定同口径（调用方负责）。
 * - status / state / type 写成字面量：Prisma 参数化枚举后规划器看不到值。
 */
export function eligibleVerifierIdsQuery(params: {
  circleId: string;
  callerId: string;
  excludedUserIds: readonly string[];
}): Prisma.Sql {
  const { circleId, callerId } = params;
  const excluded = [...params.excludedUserIds];
  return Prisma.sql`
    SELECT member."userID"
    FROM "CircleMember" AS member
    WHERE member."circleID" = ${circleId}
      AND member."status" = 'ACTIVE'
      AND member."userID" <> ALL(${excluded}::text[])
      AND member."userID" IN (
        SELECT CASE
                 WHEN friend."userID" = ${callerId} THEN friend."friendID"
                 ELSE friend."userID"
               END
        FROM "Friend" AS friend
        WHERE friend."state" = 'ACCEPTED'
          AND (friend."userID" = ${callerId} OR friend."friendID" = ${callerId})
        UNION ALL
        ${mutualDirectChatPeerIdsSql(callerId)}
      )
    ORDER BY member."createdAt" ASC
  `;
}

/** 这一对是否满足「私聊过」(口径见 mutualDirectChatPeerIdsSql)。 */
export function mutualDirectChatQuery(params: {
  applicantId: string;
  peerId: string;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM (${mutualDirectChatPeerIdsSql(params.applicantId)}) AS chatted("userID")
      WHERE chatted."userID" = ${params.peerId}
    ) AS "chatted"
  `;
}
