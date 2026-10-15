-- RefreshToken 是热写表（登录、续签和退出都会写）；必须在事务外并发建索引，
-- 避免普通 CREATE INDEX 阻塞线上认证流量。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshToken_userId_accessRevokedAt_id_idx"
ON "RefreshToken" ("userId", "accessRevokedAt", "id");
