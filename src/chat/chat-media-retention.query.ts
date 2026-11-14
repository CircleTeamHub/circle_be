import { Prisma } from 'src/generated/prisma';

/**
 * 保留期清理的候选:某一类媒体里,发送早于截止时间、正文还带着对象 key 的消息,
 * 按 ("createdAt", "id") 键集翻页。
 *
 * 落在迁移 20261111000000 的部分索引 ("type", "createdAt", "id") 上:每类一次范围扫描,
 * 读到 LIMIT 条就停;清理后正文没了 key 就离开索引。能用上的前提是 type 与其余谓词
 * 写成 SQL 字面量,与索引谓词一致 —— Prisma 会把 type 参数化,规划期看不到值,部分
 * 索引就失效(见 note-cleanup.query.ts 的说明)。改这里必须同步改迁移。
 *
 * 被收藏着的消息仍是候选(清理语句里跳过),键集游标让同一轮不会反复取到它们。
 */
export function expiredMediaCandidatesQuery(params: {
  type: string;
  cutoff: Date;
  after?: { createdAt: Date; id: string };
  limit: number;
}): Prisma.Sql {
  const { type, cutoff, after, limit } = params;
  // type 只来自 CHAT_MEDIA_RETENTION_DAYS 的键,这里再挡一道,确保拼进 SQL 的只是字面量。
  if (!/^[a-z-]+$/.test(type)) throw new Error('Invalid media type');
  const keyset = after
    ? Prisma.sql`AND ("createdAt", "id") > (${after.createdAt}, ${after.id})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT "id", "conversationID", "createdAt"
    FROM "ChatMessage"
    WHERE "deleted" = false
      AND "type" = ${Prisma.raw(`'${type}'`)}
      AND ("content" ->> 'key') IS NOT NULL
      AND "burnDurationSec" IS NULL
      AND "burnExpiresAt" IS NULL
      AND "createdAt" <= ${cutoff}
      ${keyset}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${limit}
  `;
}

/**
 * 把一批到期消息的正文换成「已过期」:去掉对象 key 与签名地址、留下尺寸时长,
 * 带回旧 key 供排队删对象。
 *
 * 跳过被任何人收藏着的消息(UserCollection.sourceID 指向它):收藏还在,对象就留着;
 * 收藏删了,下一轮自然清掉。正文变更会触发 revision 递增与会话计数更新,调用方必须
 * 先锁会话行(与焚毁清扫同一锁序)。
 */
export function purgeExpiredMediaQuery(ids: string[]): Prisma.Sql {
  return Prisma.sql`
    WITH target AS (
      SELECT m."id", m."content" AS before
      FROM "ChatMessage" AS m
      WHERE m."id" = ANY(${ids}::text[])
        AND m."deleted" = false
        AND (m."content" ->> 'key') IS NOT NULL
        AND m."burnDurationSec" IS NULL
        AND m."burnExpiresAt" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "UserCollection" AS c
          WHERE c."sourceID" = m."id"
            AND (
              c."type" <> 'NOTE'
              OR c."payload" ->> 'kind' = 'openim-message'
            )
        )
      FOR UPDATE OF m
    )
    UPDATE "ChatMessage" AS m
    SET "content" = (
      target.before - ARRAY['key', 'thumbKey', 'coverKey', 'url', 'thumbUrl']
    ) || '{"expired": true}'::jsonb
    FROM target
    WHERE m."id" = target."id"
    RETURNING
      m."id",
      target.before ->> 'key' AS "key",
      target.before ->> 'thumbKey' AS "thumbKey",
      target.before ->> 'coverKey' AS "coverKey"
  `;
}
