import { Prisma } from 'src/generated/prisma';
import type { ChatRetentionWindow } from './chat-retention';
import { UNREAD_COUNT_CAP } from './chat.constants';

/**
 * 会话列表每页的两条集合查询(末条消息、未读数),每个会话一个 LATERAL 子查询。
 * 都以字面量 `deleted = false` 过滤:规划器才能用上 20261026000300 的部分索引
 * ChatMessage_live_conversation_height_idx —— 焚毁墓碑(deleted = true,从不物理
 * 删除)堆起来之后,不用再逐条跨过去。
 *
 * 真库回归:test/postgres/chat-history-live-indexes.pg-spec.ts。
 */

function windowArrays(retentionWindows: ChatRetentionWindow[]) {
  return {
    viewerCutoffs: retentionWindows.map((window) => window.viewerCutoff),
    viewerStarts: retentionWindows.map((window) => window.viewerStartedAt),
    burnStarts: retentionWindows.map((window) => window.burnStartedAt),
    burnCutoffs: retentionWindows.map((window) => window.burnCutoff),
  };
}

/**
 * 每个会话的末条可见消息:沿 (conversationID, height) 倒着找第一条。原来的
 * DISTINCT ON 在 PG16 上没有 skip scan:要把每个会话的全部历史读出来、连正文
 * 一起排序,几个十万条的大群就是每次拉列表上百万行。
 *
 * 列名逐个写出而不是 SELECT *:唯一的目的是别把 contentHistory 拖进来
 * (见 MessageRow 上的注释)。原始 SQL 绕过 Prisma 的 omit,只能手写 ——
 * 也绕过了类型检查,漏一列 tsc 照过,chat-last-message-columns.spec 兜着。
 */
export function lastMessagesQuery(
  conversationIds: string[],
  retentionWindows: ChatRetentionWindow[],
): Prisma.Sql {
  const { viewerCutoffs, viewerStarts, burnStarts, burnCutoffs } =
    windowArrays(retentionWindows);
  return Prisma.sql`
    SELECT latest.*
    FROM unnest(
      ${conversationIds}::text[],
      ${viewerCutoffs}::timestamptz[],
      ${viewerStarts}::timestamptz[],
      ${burnStarts}::timestamptz[],
      ${burnCutoffs}::timestamptz[]
    ) AS w("conversationID", "viewerCutoff", "viewerStartedAt",
           "burnStartedAt", "burnCutoff")
    CROSS JOIN LATERAL (
      SELECT
        m."id", m."conversationID", m."height", m."senderID", m."type", m."content",
        m."clientMessageId", m."requestHash", m."replyToID", m."deleted",
        m."revokedAt", m."revokedBy", m."editedAt", m."deletedAt", m."revision",
        m."createdAt", m."burnDurationSec", m."burnExpiresAt"
      FROM "ChatMessage" AS m
      WHERE m."conversationID" = w."conversationID"
        AND m."deleted" = false
        AND (m."burnExpiresAt" IS NULL OR m."burnExpiresAt" > NOW())
        AND (
          w."viewerCutoff" IS NULL
          OR (w."viewerStartedAt" IS NOT NULL AND m."createdAt" < w."viewerStartedAt")
          OR m."createdAt" >= w."viewerCutoff"
        )
        AND (
          w."burnCutoff" IS NULL
          OR (w."burnStartedAt" IS NOT NULL AND m."createdAt" < w."burnStartedAt")
          OR m."createdAt" >= w."burnCutoff"
        )
      ORDER BY m."height" DESC
      LIMIT 1
    ) AS latest
  `;
}

/**
 * 每个会话的未读数(各自的已读水位之上),一次查询取回。
 *
 * 数到 UNREAD_COUNT_CAP 就停:界面最多显示 99+,而不封顶的 COUNT 对一个积了上万条
 * 未读的大群要逐行回表(deleted/revokedAt/createdAt/senderID 都不在索引里),每次
 * 拉会话列表都来一遍。没有未读的会话不返回行。
 */
export function unreadCountsQuery(
  userId: string,
  memberships: Array<{ conversationID: string; lastReadHeight: number }>,
  retentionWindows: ChatRetentionWindow[],
): Prisma.Sql {
  const ids = memberships.map((m) => m.conversationID);
  const floors = memberships.map((m) => m.lastReadHeight);
  const { viewerCutoffs, viewerStarts, burnStarts, burnCutoffs } =
    windowArrays(retentionWindows);
  return Prisma.sql`
    SELECT w."conversationID", unread.count
    FROM unnest(
      ${ids}::text[],
      ${floors}::int[],
      ${viewerCutoffs}::timestamptz[],
      ${viewerStarts}::timestamptz[],
      ${burnStarts}::timestamptz[],
      ${burnCutoffs}::timestamptz[]
    ) AS w("conversationID", floor, "viewerCutoff", "viewerStartedAt",
           "burnStartedAt", "burnCutoff")
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT 1
        FROM "ChatMessage" AS m
        WHERE m."conversationID" = w."conversationID"
          AND m."height" > w.floor
          AND m."deleted" = false
          AND (m."burnExpiresAt" IS NULL OR m."burnExpiresAt" > NOW())
          -- 撤回的消息不计未读:对方发了又撤回,红点不该还挂着一条看不到内容的「新消息」。
          AND m."revokedAt" IS NULL
          AND (
            w."viewerCutoff" IS NULL
            OR (w."viewerStartedAt" IS NOT NULL AND m."createdAt" < w."viewerStartedAt")
            OR m."createdAt" >= w."viewerCutoff"
          )
          AND (
            w."burnCutoff" IS NULL
            OR (w."burnStartedAt" IS NOT NULL AND m."createdAt" < w."burnStartedAt")
            OR m."createdAt" >= w."burnCutoff"
          )
          -- 自己发的消息不计未读。
          AND (m."senderID" IS NULL OR m."senderID" <> ${userId})
        LIMIT ${UNREAD_COUNT_CAP}
      ) AS capped
    ) AS unread
    WHERE unread.count > 0
  `;
}
