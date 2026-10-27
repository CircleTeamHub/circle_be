-- 发送一条消息的事务里(会话行 FOR UPDATE 期间)与群规模成正比的写开销(会话行上
-- 的另一处见 20261025000300 / 20261025000400 两个删 trigram 索引的迁移)。
--
-- CONCURRENTLY:ChatMember 是写热表。文件里不能有函数体
-- 或 DO 块,Prisma 才会把每条语句放在事务外执行。部署后查 pg_index.indisvalid,
-- 中断的并发建索引会留下 invalid 索引,IF NOT EXISTS 会把它当成已存在 —— 遇到要先
-- 手动 DROP INDEX CONCURRENTLY 再重跑。

-- 1. 每条消息(含系统消息、自动回复)都会执行
--      UPDATE "ChatMember" SET "hiddenAt" = NULL
--      WHERE "conversationID" = <会话> AND "hiddenAt" IS NOT NULL
--    原有索引都不含 hiddenAt:取 conversationID 前缀后逐行回表判断,3000 人的群每条
--    消息回表 3000 次,而绝大多数时候一行都不匹配。部分索引只收当前隐藏着的座位,
--    平时几乎是空的,探一下就结束。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_hidden_conversation_idx"
ON "ChatMember" ("conversationID")
WHERE "hiddenAt" IS NOT NULL;
