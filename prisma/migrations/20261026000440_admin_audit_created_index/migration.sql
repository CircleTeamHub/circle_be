-- 审计日志的两处默认列表都按 createdAt DESC, id DESC 分页:
--   admin-audit-query.service list(管理台操作日志,不带筛选时)
--   console-insights.service diagnostics(失败记录)
-- 现有索引的前导列都是 actorID / entityType / action,不带筛选时只能整表扫 + 排序。
--
-- 非部分索引,schema.prisma 里同步声明
--   @@index([createdAt(sort: Desc), id(sort: Desc)])
-- 名字取 Prisma 的默认名,和 schema 对齐。
--
-- CONCURRENTLY:每个管理动作都会写这张表。文件里不能有函数体或 DO 块。部署后查
-- pg_index.indisvalid,中断的并发建索引要先手动 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAuditLog_createdAt_id_idx"
ON "AdminAuditLog" ("createdAt" DESC, "id" DESC);
