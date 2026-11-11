-- 聊天媒体保留期清理(chat-media-retention.service.ts)每天按类型找「发送早于截止
-- 时间、正文还带着对象 key」的消息:
--   WHERE deleted = false AND type = '<type>' AND content->>'key' IS NOT NULL
--     AND burnDurationSec IS NULL AND burnExpiresAt IS NULL AND createdAt <= cutoff
--   ORDER BY createdAt, id
-- ChatMessage 上所有 createdAt 索引都以 conversationID 打头,全局按时间找只能全表扫。
-- 这条以 type 打头,每类一次范围扫描;清理后正文去掉 key 就离开索引,所以索引只装
-- 「还留着对象的媒体消息」。谓词必须与 chat-media-retention.query.ts 里的字面量一致。
--
-- CONCURRENTLY:ChatMessage 是全系统最热的表。文件里不能有函数体或 DO 块,Prisma 才会
-- 把语句放在事务外执行。部署后查 pg_index.indisvalid,中断的并发建索引会留下 invalid
-- 索引,IF NOT EXISTS 会把它当成已存在 —— 遇到要先手动 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_media_retention_idx"
ON "ChatMessage" ("type", "createdAt", "id")
WHERE "deleted" = false
  AND "type" IN ('image', 'video', 'voice', 'file')
  AND ("content" ->> 'key') IS NOT NULL
  AND "burnDurationSec" IS NULL
  AND "burnExpiresAt" IS NULL;
