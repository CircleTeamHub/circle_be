import { Prisma } from 'src/generated/prisma';

/**
 * 发送临界区用到的三条原生 SQL。
 *
 * 发送事务对会话行 FOR UPDATE,同会话的发送、清空、焚毁都在这把锁上串行;锁里
 * 每多一次往返,排队的发送就多等一次,等锁的事务还各占一个池连接。这里把锁内能
 * 合并的语句合并掉,锁外能做的判定挪到锁外。
 */

/**
 * 锁行时顺带读回锁内复查要用的全部会话列(禁言、拉黑、临时房、加密、取号)。
 *
 * 只读**被锁的这一行**:等锁之后 PostgreSQL 会对这一行取最新提交版本重算
 * (EvalPlanQual),所以这些列与锁同样新。别的表不能塞进这条语句 —— 等过锁的
 * 话,子查询仍用语句开始时的快照,会漏看刚刚放锁的那个事务写下的行
 * (比如同一个 d 的并发重发),幂等查重与座位复查因此仍是锁后单独的语句。
 */
export function lockConversationForSendQuery(
  conversationId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT "nextHeight", "textEncryption", "type"::text AS "type", "directKey",
           "circleID", "ownerID", "muteAllAt", "tempChatID"
    FROM "ChatConversation"
    WHERE "id" = ${conversationId}
    FOR UPDATE`;
}

/**
 * 落库之后的两步写合成一条语句:推进计数器与会话排序时间(updatedAt 照 Prisma
 * @updatedAt 的口径一并写),同时让所有隐藏了这个会话的成员重新看到它(微信式语义)。
 *
 * 两个 UPDATE 在同一条语句里共用一个快照;语句在持锁之后才开始,看到的已提交
 * 状态与原来先后两条语句一致。原来是 chatConversation.update + chatMember.updateMany
 * 两次往返。
 */
export function advanceConversationAfterSendQuery(
  conversationId: string,
  height: number,
  lastMessageAt: Date,
  updatedAt: Date,
): Prisma.Sql {
  return Prisma.sql`
    WITH resurfaced AS (
      UPDATE "ChatMember" SET "hiddenAt" = NULL
      WHERE "conversationID" = ${conversationId} AND "hiddenAt" IS NOT NULL
    )
    UPDATE "ChatConversation"
    SET "nextHeight" = ${height}, "lastMessageAt" = ${lastMessageAt},
        "updatedAt" = ${updatedAt}
    WHERE "id" = ${conversationId}`;
}

/**
 * 单聊已读有没有需要启动的阅后即焚计时 —— 与 startReadBurnTimers 的 UPDATE
 * 同一组谓词(read-burn-timers.ts;pg 回归逐条对拍两者)。
 *
 * 为真才需要会话行锁:启动计时会改消息行,取号触发器随之更新会话行,必须先取
 * 会话锁才能与发送/清空/焚毁保持同一加锁顺序。为假时这一组只会变小(消息高度
 * ≤ 已提交的 nextHeight,计时只会从 NULL 变成有值,删除/撤回/离座/清空水位都
 * 只减不增),之后再看也不会冒出新的待启动计时,跳过锁与原来等价。
 *
 * 走部分索引 ChatMessage_pending_read_burn_idx(conversationID, height)。
 */
export function pendingReadBurnTimersQuery(
  conversationId: string,
  userId: string,
  height: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "ChatMessage" m
      JOIN "ChatConversation" c ON c."id" = m."conversationID"
      JOIN "ChatMember" reader ON reader."conversationID" = c."id"
      WHERE m."conversationID" = ${conversationId}
        AND m."height" <= ${height}
        AND reader."userID" = ${userId}
        AND c."type" = 'DIRECT'
        AND reader."leftAt" IS NULL
        AND m."height" > GREATEST(reader."clearedBeforeHeight", c."clearedBeforeHeight")
        AND m."senderID" <> reader."userID" AND m."createdAt" >= reader."joinedAt"
        AND m."burnDurationSec" > 0 AND m."burnExpiresAt" IS NULL
        AND m."deleted" = false AND m."revokedAt" IS NULL
    ) AS "pending"`;
}
