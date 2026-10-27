-- 朋友圈 feed / 详情的点赞预览与评论预览（src/trace/trace-preview.query.ts）：每条动态
-- 只取最新 N 条，LATERAL 子查询里 ORDER BY 时间倒序 LIMIT N。原先是 Prisma 嵌套
-- include 的 take，SQL 里没有 LIMIT，每条动态的全部点赞 / 评论都会被读出来。
--
-- 1. TraceComment ("traceID", "createdAt")
--    按动态取最新评论 = 一次倒序索引扫描，跳过已删的、凑够 N 条就停。原有的
--    TraceComment_traceID_idx 是它的严格前缀，由紧随其后的 20261026000540 删掉
--    （DROP INDEX CONCURRENTLY 必须单独一份迁移）。普通索引，schema.prisma 里
--    TraceComment 的 @@index([traceID]) 同步改成 @@index([traceID, createdAt])。
--
-- 2. traceLikeStat ("traceID", "updatedAt") WHERE "deleted" = false
--    原来只有 (traceID, userID) 唯一索引：取前 N 个赞要把这条动态的全部点赞行回表、
--    排序。部分索引只收有效的赞（取消点赞是软删 deleted = true），查询里
--    "deleted" = false 必须是字面量、与这里一字不差。部分索引 Prisma schema 表达
--    不了，按仓库惯例不在 schema.prisma 里声明。
--
-- CONCURRENTLY：评论 / 点赞是写热表。文件里只能有普通语句（不能有函数体或 DO 块），
-- Prisma 才会把每条语句放在事务外执行。部署后查 pg_index.indisvalid：中断的并发建
-- 索引会留下 indisvalid = false 的残骸，IF NOT EXISTS 会把它当成已建好而跳过，必须
-- 先手动 DROP INDEX CONCURRENTLY 再重跑迁移。

CREATE INDEX CONCURRENTLY IF NOT EXISTS "TraceComment_traceID_createdAt_idx"
ON "TraceComment" ("traceID", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "traceLikeStat_live_traceID_updatedAt_idx"
ON "traceLikeStat" ("traceID", "updatedAt")
WHERE "deleted" = false;
