-- 聊天媒体 key / thumbKey 表达式的扩展统计。
--
-- 20261019000300 的四条表达式索引都是部分索引，PostgreSQL 不拿部分索引的统计信息估算
-- 表达式的选择率，(content ->> 'key') = ANY(一批 key) 只能按默认的每个值 0.5% 估：
-- 存量盘点每批 1000 个 key 时估成「几乎整张表都匹配」，焚毁归档这种中等大小的表就
-- 退成每批一次全表扫描（批数 × 整表，比原来扫一遍还慢）。有了表达式统计（key 几乎
-- 两两不同），估算回到「每个 key 一两行」，反查稳定走索引。
--
-- CREATE STATISTICS 只改目录、拿 ShareUpdateExclusiveLock，不挡读写；ANALYZE 按块
-- 抽样（与表大小无关的固定样本量），把统计先填上，不必等 autovacuum。
CREATE STATISTICS IF NOT EXISTS "ChatMessage_media_key_expr_stats" (ndistinct)
ON ("content" ->> 'key'), ("content" ->> 'thumbKey')
FROM "ChatMessage";

CREATE STATISTICS IF NOT EXISTS "ChatBurnArchive_media_key_expr_stats" (ndistinct)
ON ("content" ->> 'key'), ("content" ->> 'thumbKey')
FROM "ChatBurnArchive";

ANALYZE "ChatMessage";

ANALYZE "ChatBurnArchive";
