-- 删掉冗余索引 "TraceComment_traceID_idx"：它是上一份迁移（20261026000530）建的
-- "TraceComment_traceID_createdAt_idx" ("traceID", "createdAt") 的严格前缀。按 traceID
-- 的等值查询和外键级联（删动态时级联删评论）都能走新索引，这条只增加写入成本。
-- schema.prisma 里 TraceComment 的 @@index([traceID]) 同步改成 @@index([traceID, createdAt])。
--
-- 一份迁移只放这一条：DROP INDEX CONCURRENTLY 和别的语句混写时 Prisma 会把整份放进
-- 事务，部署报 25001（见 src/prisma/concurrent-index-migrations.spec.ts）。
-- 回滚：CREATE INDEX CONCURRENTLY IF NOT EXISTS "TraceComment_traceID_idx" ON "TraceComment"("traceID")
DROP INDEX CONCURRENTLY IF EXISTS "TraceComment_traceID_idx";
