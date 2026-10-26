import { Prisma } from 'src/generated/prisma';

/**
 * 加密发送准入与密文归档用到的加锁/批量查询。
 *
 * 所有 FOR SHARE 都只在被锁表自身上取列:等锁之后 PostgreSQL 对被锁行取最新提交
 * 版本重算(EvalPlanQual),读回的列与锁同样新;别的表的数据一律另起语句再读。
 */

/** 房间里当前(未移除)设备的完整行,同时 FOR SHARE —— 与设备吊销(FOR UPDATE)排出先后。 */
export function lockRoomDevicesQuery(conversationID: string): Prisma.Sql {
  return Prisma.sql`
    SELECT d."id", d."userID", d."purpose", d."status", d."publicKey"
    FROM "E2eeDevice" d
    WHERE d."id" IN (
      SELECT "deviceID" FROM "E2eeRoomDevice"
      WHERE "conversationID" = ${conversationID} AND "removedEpoch" IS NULL
    )
    ORDER BY d."id"
    FOR SHARE`;
}

export type AuditAdminRow = {
  id: string;
  role: string;
  status: string;
  adminRole: string;
};

/**
 * 审计管理员的账号状态与后台角色,User 行与 AdminAccess 行一起 FOR SHARE ——
 * 与降权/封禁(UPDATE User / AdminAccess,取 FOR NO KEY UPDATE)排出先后。
 * 没有 AdminAccess 行的管理员不返回(本来就没有 IM_READ),调用方按无权限处理。
 * 按 id 排序加锁,多个管理员的加锁顺序固定。
 */
export function lockAuditAdminsQuery(userIDs: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT u."id", u."role"::text AS "role", u."status"::text AS "status",
           a."role"::text AS "adminRole"
    FROM "User" u
    JOIN "AdminAccess" a ON a."userID" = u."id"
    WHERE u."id" = ANY(${userIDs}::text[])
    ORDER BY u."id"
    FOR SHARE`;
}

export type EncryptedSeatCounts = {
  seats: number;
  allSeats: number;
  activeOwners: number;
};

/**
 * 加密房间的成员一致性:设备所有人里在座的人数、会话在座总人数、设备所有人里
 * 账号仍 ACTIVE 的人数。原来是三次 count。(conversationID, userID) 唯一,
 * 所以 FILTER 计数与原来的 count({ userID: { in } }) 相同。
 */
export function encryptedSeatCountsQuery(
  conversationID: string,
  owners: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE m."userID" = ANY(${owners}::text[]))::int AS "seats",
      count(*)::int AS "allSeats",
      (
        SELECT count(*)::int FROM "User" u
        WHERE u."id" = ANY(${owners}::text[]) AND u."status" = 'ACTIVE'
      ) AS "activeOwners"
    FROM "ChatMember" m
    WHERE m."conversationID" = ${conversationID} AND m."leftAt" IS NULL`;
}

/** 归档涉及的会话行一次 FOR SHARE(按 id 排序),顺带读回会话级清空水位。 */
export function lockArchiveConversationsQuery(
  conversationIDs: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT "id", "clearedBeforeHeight"
    FROM "ChatConversation"
    WHERE "id" = ANY(${conversationIDs}::text[])
    ORDER BY "id"
    FOR SHARE`;
}

/** 本人在这些会话里的座位行一次 FOR SHARE(按会话排序),读回离座与清空水位。 */
export function lockArchiveSeatsQuery(
  conversationIDs: string[],
  userID: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT "conversationID", "leftAt", "clearedBeforeHeight"
    FROM "ChatMember"
    WHERE "conversationID" = ANY(${conversationIDs}::text[]) AND "userID" = ${userID}
    ORDER BY "conversationID"
    FOR SHARE`;
}

/**
 * 仍然存活(未焚毁、未撤回)的消息行一次 FOR SHARE(按 id 排序),与撤回/焚毁触发器
 * 排出先后;已焚毁/撤回的行不锁(与原来逐条语句的过滤一致),只返回锁住的 id。
 */
export function lockLiveArchiveMessagesQuery(messageIDs: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "ChatMessage"
    WHERE "id" = ANY(${messageIDs}::text[]) AND NOT "deleted" AND "revokedAt" IS NULL
    ORDER BY "id"
    FOR SHARE`;
}
