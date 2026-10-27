-- 管理台推送页(console-operations.service):
--   pushOverview  —— groupBy status WHERE createdAt >= now() - 24h
--   pushes        —— ORDER BY createdAt DESC, id DESC 的游标分页
-- NotificationPushOutbox 只有 (status, nextAttemptAt) 和 notificationID 唯一键,两条都
-- 是整表扫 + 排序;这张表每条推送一行,只随通知保留期清理(级联)才会变小。
--
-- 非部分索引,schema.prisma 里同步声明
--   @@index([createdAt(sort: Desc), id(sort: Desc)])
-- 名字取 Prisma 的默认名,和 schema 对齐(否则 CI 的 drift 检查会要求改名)。
--
-- CONCURRENTLY:每条通知都会写这张表。文件里不能有函数体或 DO 块。部署后查
-- pg_index.indisvalid,中断的并发建索引要先手动 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "NotificationPushOutbox_createdAt_id_idx"
ON "NotificationPushOutbox" ("createdAt" DESC, "id" DESC);
