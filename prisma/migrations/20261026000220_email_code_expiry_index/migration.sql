-- EmailVerificationCode 按过期时间清理用的索引。
--
-- 这张表此前没有任何清理任务,只增不减。RefreshTokenCleanup 每 10 分钟顺带删
-- expiresAt 早于「now - 1 天」的行,按 expiresAt 升序分批取(每批 1000 行):
--   SELECT id FROM "EmailVerificationCode" WHERE "expiresAt" < $1
--   ORDER BY "expiresAt" ASC LIMIT 1000
-- 原有的 ("email", "purpose") 索引帮不上,没有这个索引每批都要全表扫描再排序。
--
-- CONCURRENTLY:同 20261026000200,文件里只放 CREATE INDEX CONCURRENTLY,部署后核对
-- pg_index.indisvalid。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EmailVerificationCode_expiresAt_idx"
ON "EmailVerificationCode" ("expiresAt");
