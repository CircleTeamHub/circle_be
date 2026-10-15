-- RefreshToken 是热写表（登录、续签和退出都会写）；必须在事务外并发建索引，
-- 避免普通 CREATE INDEX 阻塞线上认证流量。
CREATE INDEX CONCURRENTLY "RefreshToken_access_revoke_outbox_idx"
ON "RefreshToken" ("accessTokenExpiresAt", "expiredAt", "id")
WHERE "accessRevokedAt" IS NOT NULL
  AND "accessRevocationNotifiedAt" IS NULL;
