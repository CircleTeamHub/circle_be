import { Prisma } from 'src/generated/prisma';

/**
 * 圈子群对账的一行差集:
 * - create:ACTIVE 成员在这个会话里还没有座位 → 新建座位;
 * - rejoin:ACTIVE 成员的座位已离座(leftAt 非空) → 复活;
 * - remove:在座(leftAt 为空)的人已不是这个圈子的 ACTIVE 成员 → 离座。
 */
export type CircleSeatChange = {
  userID: string;
  action: 'create' | 'rejoin' | 'remove';
};

/**
 * 圈子 ACTIVE 成员与群座位的差集,一条语句在库里算完(ensureCircleConversation 在
 * 圈子 advisory lock 下调用)。原来每次都把全部 ACTIVE 成员和全部座位读回应用,再拿
 * ≤3000 个 userID 拼 IN / NOT IN 写两遍 —— 绝大多数时候其实没有任何变化。
 *
 * 两半各走现成的索引:成员侧 (circleID, status, userID),座位侧
 * (conversationID, userID) 唯一索引。status 写成字面量(参数化的枚举要 CAST)。
 * 结果按 (action, userID) 排序,只为输出稳定。
 */
export function circleSeatDiffQuery(
  circleId: string,
  conversationId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT diff."userID", diff.action
    FROM (
      SELECT cm."userID",
             CASE WHEN seat."userID" IS NULL THEN 'create' ELSE 'rejoin' END AS action
      FROM "CircleMember" AS cm
      LEFT JOIN "ChatMember" AS seat
        ON seat."conversationID" = ${conversationId}
       AND seat."userID" = cm."userID"
      WHERE cm."circleID" = ${circleId}
        AND cm."status" = 'ACTIVE'
        AND (seat."userID" IS NULL OR seat."leftAt" IS NOT NULL)
      UNION ALL
      SELECT seat."userID", 'remove' AS action
      FROM "ChatMember" AS seat
      WHERE seat."conversationID" = ${conversationId}
        AND seat."leftAt" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "CircleMember" AS cm
          WHERE cm."circleID" = ${circleId}
            AND cm."status" = 'ACTIVE'
            AND cm."userID" = seat."userID"
        )
    ) AS diff
    ORDER BY diff.action, diff."userID"
  `;
}
