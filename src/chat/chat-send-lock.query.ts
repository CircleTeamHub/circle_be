import {
  type ChatConversationType,
  type ChatMemberRole,
  Prisma,
} from 'src/generated/prisma';

/**
 * 发送路径上的原生 SQL。
 *
 * 发送事务对会话行 FOR UPDATE,同会话的发送、清空、焚毁都在这把锁上串行;锁里
 * 每多一次往返,排队的发送就多等一次,等锁的事务还各占一个池连接。这里把锁内能
 * 合并的语句合并掉,锁外能做的判定挪到锁外。
 *
 * 锁外也一样要省:压测里后端单核一半以上的时间花在「发起一次数据库往返」本身
 * (Prisma 运行时 + 驱动收发),而不是哪条语句慢。能一条语句读完的不要拆成几条。
 */

/**
 * sendPreflightQuery 的结果行:发送者的座位、会话、对端,以及发送要用到的「人」的
 * 信息。会话列与座位列平铺在一行里,可以直接当会话 / 座位传给判定函数。
 */
export interface SendPreflightRow {
  // ── 座位(ChatMember)
  userID: string;
  role: ChatMemberRole;
  leftAt: Date | null;
  silencedAt: Date | null;
  silencedUntil: Date | null;
  alias: string | null;
  // ── 会话(ChatConversation)
  type: ChatConversationType;
  directKey: string | null;
  circleID: string | null;
  ownerID: string | null;
  muteAllAt: Date | null;
  tempChatID: string | null;
  /** 会话级焚毁档位(不是座位上发送者自己的那份)。 */
  burnDurationSec: number | null;
  burnStartedAt: Date | null;
  /** 单聊的对端;群、临时房、自己和自己的单聊为 null。 */
  peerUserId: string | null;
  // ── 发送者
  /** 发送者自己的全局阅后即焚窗口;没有隐私行 = 没开(0)。 */
  selfDestructSec: number;
  /** 账号昵称与头像;访客(临时房)没有 User 行,两列都是 null。 */
  senderNickname: string | null;
  senderAvatarUrl: string | null;
  // ── 对端(peerUserId 为 null 时恒为 false / 空串)
  blocked: boolean;
  autoReplyEnabled: boolean;
  autoReplyText: string;
  rechargeAgent: boolean;
}

/**
 * 锁外预检要读的全部内容,一条语句取回 —— 原来是 6~7 次往返:座位、会话、发送者的
 * 焚毁窗口、单聊拉黑、对方的自动回复开关、对方是不是在岗的充值客服,以及提交之后
 * 再查一次的发送者昵称头像。
 *
 * 这里读到的都只是闸或展示信息:在座、禁言、拉黑、临时房在取到会话行锁之后还要
 * 复查(lockedSendRecheckQuery 与锁行读回的会话列),自动回复 / 充值客服由各自的
 * 处理器在锁下权威复查。
 *
 * 对端从 directKey 推(不可变):按顺序取第一个不是发送者的那一段,与原来的
 * `directKey.split(':').find((id) => id !== sender)` 同一个口径 —— 自己和自己的
 * 单聊没有对端。没有座位行时返回零行。
 */
export function sendPreflightQuery(
  conversationId: string,
  senderUserId: string,
): Prisma.Sql {
  const sender = Prisma.sql`${senderUserId}`;
  return Prisma.sql`
    SELECT seat."userID", seat."role"::text AS "role", seat."leftAt",
           seat."silencedAt", seat."silencedUntil", seat."alias",
           c."type"::text AS "type", c."directKey", c."circleID", c."ownerID",
           c."muteAllAt", c."tempChatID", c."burnDurationSec", c."burnStartedAt",
           peer."id" AS "peerUserId",
           COALESCE(mine."messageSelfDestructSec", 0) AS "selfDestructSec",
           account."nickname" AS "senderNickname",
           account."avatarUrl" AS "senderAvatarUrl",
           ${directBlockExists(sender, Prisma.sql`peer."id"`)} AS "blocked",
           COALESCE(theirs."directMessageAutoReplyEnabled", false) AS "autoReplyEnabled",
           COALESCE(theirs."directMessageAutoReplyText", '') AS "autoReplyText",
           EXISTS (
             SELECT 1 FROM "SupportAgent" agent
             JOIN "User" agent_account ON agent_account."id" = agent."userID"
             WHERE agent."userID" = peer."id" AND agent."category" = 'recharge'
               AND agent."enabled" AND agent_account."status" = 'ACTIVE'
           ) AS "rechargeAgent"
    FROM "ChatMember" seat
    JOIN "ChatConversation" c ON c."id" = seat."conversationID"
    LEFT JOIN LATERAL (
      SELECT part AS "id"
      FROM unnest(string_to_array(c."directKey", ':')) WITH ORDINALITY AS parts(part, position)
      WHERE c."type" = 'DIRECT' AND part <> ${sender}
      ORDER BY position
      LIMIT 1
    ) peer ON true
    LEFT JOIN "User" account ON account."id" = seat."userID"
    LEFT JOIN "UserPrivacySetting" mine ON mine."userID" = seat."userID"
    LEFT JOIN "UserPrivacySetting" theirs ON theirs."userID" = peer."id"
    WHERE seat."conversationID" = ${conversationId}
      AND seat."userID" = ${sender}`;
}

/** 单聊任一方向拉黑;对端为 NULL 时恒为 false。两个参数都是 SQL 表达式。 */
function directBlockExists(sender: Prisma.Sql, peer: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "Block" b
    WHERE (b."blockerID" = ${sender} AND b."blockedID" = ${peer})
       OR (b."blockerID" = ${peer} AND b."blockedID" = ${sender})
  )`;
}

/**
 * 锁行时顺带读回锁内复查要用的全部会话列(禁言、拉黑、临时房、取号)。
 *
 * 只读**被锁的这一行**:等锁之后 PostgreSQL 会对这一行取最新提交版本重算
 * (EvalPlanQual),所以这些列与锁同样新。别的表不能塞进这条语句 —— 等过锁的
 * 话,子查询仍用语句开始时的快照,会漏看刚刚放锁的那个事务写下的行
 * (比如同一个 d 的并发重发),幂等查重与座位复查因此是锁后单独的一条语句
 * (lockedSendRecheckQuery)。
 */
export function lockConversationForSendQuery(
  conversationId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT "nextHeight", "type"::text AS "type", "directKey",
           "circleID", "ownerID", "muteAllAt", "tempChatID"
    FROM "ChatConversation"
    WHERE "id" = ${conversationId}
    FOR UPDATE`;
}

/** lockedSendRecheckQuery 的结果行:发送者的座位 + 拉黑 + 幂等命中。 */
export interface LockedSendSeatRow {
  userID: string;
  role: ChatMemberRole;
  leftAt: Date | null;
  silencedAt: Date | null;
  silencedUntil: Date | null;
  burnDurationSec: number | null;
  alias: string | null;
  blocked: boolean;
  /** 同一个 (会话, 发送者, d) 已经落过库的那条消息;没有则 null。 */
  existingMessageId: string | null;
}

/**
 * 取到会话行锁之后的复查,一条语句读完:发送者的座位(在座、禁言、焚毁档位、
 * 群昵称)、单聊拉黑、幂等查重。原来是三次往返,都在持锁期间。
 *
 * 必须是锁行**之后**单独开始的语句:READ COMMITTED 下每条语句开始时取新快照,
 * 这样才看得到刚放锁的那个事务写下的行(并发的同 d 重发、刚生效的踢人)。三项
 * 合在一条里共用一个快照,比原来先后三条语句更一致,不会更旧。
 *
 * 不在座(没有座位行)时返回零行。
 */
export function lockedSendRecheckQuery(
  conversationId: string,
  senderUserId: string,
  peerUserId: string | null,
  clientMessageId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT seat."userID", seat."role"::text AS "role", seat."leftAt",
           seat."silencedAt", seat."silencedUntil", seat."burnDurationSec",
           seat."alias",
           ${directBlockExists(Prisma.sql`${senderUserId}`, Prisma.sql`${peerUserId}`)} AS "blocked",
           (
             SELECT sent."id" FROM "ChatMessage" sent
             WHERE sent."conversationID" = ${conversationId}
               AND sent."senderID" = ${senderUserId}
               AND sent."clientMessageId" = ${clientMessageId}
           ) AS "existingMessageId"
    FROM "ChatMember" seat
    WHERE seat."conversationID" = ${conversationId}
      AND seat."userID" = ${senderUserId}`;
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
