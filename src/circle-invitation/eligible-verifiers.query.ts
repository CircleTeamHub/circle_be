import { Prisma } from 'src/generated/prisma';

/**
 * 申请人可挑的验证人 id = 本圈 ACTIVE 成员 ∩ 申请人的已接受好友 − 排除名单（已占席的、
 * 申请人自己），按入圈先后（createdAt 升序）。
 *
 * 此前分两步：先把本圈 ACTIVE 成员全拉进内存（圈子容量上限 3000，没有 take），再拿
 * 两个各 3000 项的 IN 去查好友表。现在一条语句：好友集合是 IN 子查询（走 Friend 的
 * (userID, friendID) / (friendID, userID) 索引），规划器可以先取出申请人的好友、再按
 * (userID, circleID) 唯一索引逐个探测成员行，也可以反过来 —— 哪边小从哪边收窄，
 * 不再把整圈成员搬到应用里。
 *
 * - 好友方向：friend 表一对好友只存一行，申请人可能在 userID 也可能在 friendID 一侧；
 *   CASE 取另一侧。同一对偶有重复行时，IN 是半连接，结果天然不重。
 * - 排除名单「不看状态」，与 addVerifier 的 AlreadyVerifier 判定同口径（调用方负责）。
 * - status / state 写成字面量：Prisma 参数化枚举后规划器看不到值。
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
      )
    ORDER BY member."createdAt" ASC
  `;
}
