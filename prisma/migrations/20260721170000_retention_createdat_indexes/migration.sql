-- round 3 review：普通 CREATE INDEX 会在整个构建期间阻塞写入。Prisma 迁移
-- 跑在事务里，无法用 CONCURRENTLY；这里改为 IF NOT EXISTS —— 大表部署可先
-- 手工 `CREATE INDEX CONCURRENTLY <同名索引>` 预建（本迁移即变 no-op），
-- 小表（当前测试规模）直接跑代价可忽略。
-- review 修复（#95 保留期清理的查询形状）：两张表按 createdAt 截断删除，
-- 但 Notification 没有任何 createdAt 索引、FriendActivity 只有 viewer 前缀
-- 索引 —— 成熟表上每天一次顺序扫描。补裸 createdAt 索引支撑
-- `WHERE "createdAt" < cutoff LIMIT n` 的分批删除。
CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX IF NOT EXISTS "FriendActivity_createdAt_idx" ON "FriendActivity"("createdAt");
