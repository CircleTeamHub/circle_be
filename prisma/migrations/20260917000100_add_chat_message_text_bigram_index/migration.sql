-- 消息关键词搜索(会话内搜索、全局搜索)的 GIN 索引:按文本二元组(chat_text_bigrams)
-- 找候选,再由 LIKE 复核。原来是 jsonb 路径上的 LIKE '%词%',没有任何索引可用 ——
-- 全局搜一个罕见词要把本人所有会话的消息逐行读一遍。
--
-- 部分索引:只有文本与引用消息带 content.text,已焚毁的墓碑正文为空。查询必须带同样
-- 的 deleted = false AND type IN ('text', 'quote') 条件才用得上它。
--
-- ChatMessage 是全系统最热的表,普通 CREATE INDEX 在构建期间挡住所有写入;这里
-- CONCURRENTLY(docs/migration-baseline.md 的约定,先例 20260916000200)。本文件不含
-- 美元符号引用,语句单独自动提交,CONCURRENTLY 才允许执行。
--
-- 失败会留下 indisvalid = false 的同名残骸,IF NOT EXISTS 重跑会直接跳过:按
-- migration-baseline.md 的部署自检查无效索引并手工清理后重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_text_bigrams_idx"
ON "ChatMessage" USING gin (chat_text_bigrams("content" ->> 'text'))
WHERE "deleted" = false AND "type" IN ('text', 'quote');
