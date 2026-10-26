import { Prisma } from 'src/generated/prisma';

/**
 * 单字全局搜索只看每个会话最近这么多条消息(和 App 本地库每会话保留的深度一致)。
 *
 * 单字的二元组集合是空的(chat_text_bigrams 至少要两个字),`@> '{}'` 恒真、bigram
 * 索引用不上 —— 不设窗口的话只剩「本人所有会话的文本消息逐行解 jsonb 做 LIKE 再
 * 排序」,加了几个十万条的大群,输入第一个字就能顶到语句超时。两个字及以上照旧走
 * bigram 索引、搜全部历史;更早的单字命中靠多输一个字。
 */
export const SINGLE_CHAR_SEARCH_WINDOW = 500;

/**
 * 单字搜索的候选:每个会话先沿 (conversationID, createdAt) WHERE deleted = false 的
 * 部分索引倒序取最近 SINGLE_CHAR_SEARCH_WINDOW 条,再在窗口里做 LIKE。每次请求最多
 * 读「会话数 × 窗口」行。
 *
 * - `deleted = false` 必须是字面量,规划器才能用上那条部分索引;
 * - 翻页游标 `before` 放在窗口外层:后续轮次只在同一个窗口里往下翻,不会把窗口
 *   挪到更早的历史上(那样又成了无界扫描)。
 * - 可见性(清空水位、阅后即焚、查看者窗口)由调用方在候选上统一过滤,与 bigram 路径一致。
 */
export function recentTextMatchesQuery(
  conversationIds: readonly string[],
  likePattern: string,
  before: { createdAt: Date; id: string } | null,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT recent."id", recent."createdAt"
    FROM unnest(${[...conversationIds]}::text[]) AS c("conversationID")
    CROSS JOIN LATERAL (
      SELECT m."id", m."createdAt", m."type", m."content", m."burnExpiresAt"
      FROM "ChatMessage" AS m
      WHERE m."conversationID" = c."conversationID"
        AND m."deleted" = false
      ORDER BY m."createdAt" DESC
      LIMIT ${SINGLE_CHAR_SEARCH_WINDOW}
    ) AS recent
    WHERE recent."type" IN ('text', 'quote')
      AND (recent."burnExpiresAt" IS NULL OR recent."burnExpiresAt" > NOW())
      AND (recent."content" ->> 'text') LIKE ${likePattern} ESCAPE '\\'
      AND (
        ${before?.createdAt ?? null}::timestamptz IS NULL
        OR (recent."createdAt", recent."id") < (${before?.createdAt ?? null}::timestamptz, ${before?.id ?? null}::text)
      )
    ORDER BY recent."createdAt" DESC, recent."id" DESC
    LIMIT ${limit}
  `;
}
