import { Prisma } from 'src/generated/prisma';

/**
 * 「哪些会话里还有指向这些笔记的有效卡片」—— 笔记来源状态广播用它找没收藏、
 * 只在聊天里见过卡片的接收人。
 *
 * 卡片 content 里的来源指针有两个键：现行卡片写 sourceNoteId，早于它的老卡片
 * 用 noteId 当来源指针，两个都要查，老卡片的接收人才不会漏掉。
 *
 * 每个键在 ChatMessage 上都有一条部分表达式索引（迁移
 * 20261025000000_note_card_reference_indexes）。能不能用上取决于两处一字不差：
 * - "type" / "deleted" 必须是 SQL 字面量。参数化后规划期看不到值，PG 证明不了
 *   查询条件蕴含索引的 WHERE，只能退回全表扫描；
 * - 键表达式必须和索引里的 ("content" ->> '<key>') 完全相同。
 * 改这里就必须同步改迁移（note-card-reference-index-migration.spec 与真库回归
 * test/postgres/note-card-recipients.pg-spec.ts 会拦）。
 *
 * id 走一个 text[] 参数 + = ANY：每个键一次索引探测（计划里是 BitmapOr），
 * id 再多也只发一条语句，不受绑定参数个数上限影响。
 */
export function noteCardConversationsQuery(
  noteIds: readonly string[],
): Prisma.Sql {
  const ids = [...noteIds];
  return Prisma.sql`
    SELECT DISTINCT "conversationID"
    FROM "ChatMessage"
    WHERE "type" = 'note-card'
      AND "deleted" = false
      AND "revokedAt" IS NULL
      AND (
        ("content" ->> 'sourceNoteId') = ANY(${ids}::text[])
        OR ("content" ->> 'noteId') = ANY(${ids}::text[])
      )
  `;
}
