-- 删掉冗余索引 "CirclePostReport_postID_idx":它是"CirclePostReport_postID_reporterID_idx"(postID, reporterID) 的严格前缀(那条不是部分索引;部分唯一索引 CirclePostReport_pending_unique 不算覆盖)。
-- 按 postID 的等值查询和外键级联都能走覆盖它的那条索引,这条只增加写入成本
-- (覆盖索引不是部分索引、前导列一致,见 test/postgres/index-redundant-drops.pg-spec.ts)。
-- schema.prisma 里对应的 @@index 同步删除。
--
-- 一份迁移只放这一条:DROP INDEX CONCURRENTLY 和别的语句混写时 Prisma 会把整份放进
-- 事务,部署报 25001(见 src/prisma/concurrent-index-migrations.spec.ts)。
-- 回滚:CREATE INDEX CONCURRENTLY IF NOT EXISTS "CirclePostReport_postID_idx" ON "CirclePostReport"("postID")
DROP INDEX CONCURRENTLY IF EXISTS "CirclePostReport_postID_idx";
