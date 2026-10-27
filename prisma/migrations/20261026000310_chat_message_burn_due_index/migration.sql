-- 焚毁清扫(chat-burn-sweeper.service.ts)每分钟先找「有到期未扫消息的会话」:
--   ChatConversation WHERE EXISTS (ChatMessage WHERE deleted = false AND burnExpiresAt <= now)
-- 原有的 ChatMessage_burn_expiry_active_idx 是 (conversationID, burnExpiresAt),按到期
-- 时间找只能把整条部分索引 —— 所有开着焚毁、还没到期的消息 —— 扫一遍,开焚毁的人越多
-- 每分钟越贵。这条以 burnExpiresAt 打头,到期的那一小段按范围直接取;焚毁后
-- deleted = true 就离开索引。逐会话取消息仍走原来那条,不动。
--
-- CONCURRENTLY:ChatMessage 是全系统最热的表。文件里不能有函数体或 DO 块,Prisma 才会
-- 把语句放在事务外执行。部署后查 pg_index.indisvalid,中断的并发建索引会留下 invalid
-- 索引,IF NOT EXISTS 会把它当成已存在 —— 遇到要先手动 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_burn_due_idx"
ON "ChatMessage" ("burnExpiresAt")
WHERE "deleted" = false AND "burnExpiresAt" IS NOT NULL;
