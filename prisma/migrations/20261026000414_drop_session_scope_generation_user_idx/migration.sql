-- 删掉冗余索引 "SessionScopeGeneration_userId_idx":它是唯一键 "SessionScopeGeneration_userId_scope_scopeKey_key"(userId, scope, scopeKey) 的严格前缀。
-- 按 userId 的等值查询和外键级联都能走覆盖它的那条索引,这条只增加写入成本
-- (覆盖索引不是部分索引、前导列一致,见 test/postgres/index-redundant-drops.pg-spec.ts)。
-- schema.prisma 里对应的 @@index 同步删除。
--
-- 一份迁移只放这一条:DROP INDEX CONCURRENTLY 和别的语句混写时 Prisma 会把整份放进
-- 事务,部署报 25001(见 src/prisma/concurrent-index-migrations.spec.ts)。
-- 回滚:CREATE INDEX CONCURRENTLY IF NOT EXISTS "SessionScopeGeneration_userId_idx" ON "SessionScopeGeneration"("userId")
DROP INDEX CONCURRENTLY IF EXISTS "SessionScopeGeneration_userId_idx";
