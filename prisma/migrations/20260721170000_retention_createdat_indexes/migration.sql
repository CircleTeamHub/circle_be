-- review 修复（#95 保留期清理的查询形状）：两张表按 createdAt 截断删除，
-- 但 Notification 没有任何 createdAt 索引、FriendActivity 只有 viewer 前缀
-- 索引 —— 成熟表上每天一次顺序扫描。补裸 createdAt 索引支撑
-- `WHERE "createdAt" < cutoff LIMIT n` 的分批删除。
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "FriendActivity_createdAt_idx" ON "FriendActivity"("createdAt");
