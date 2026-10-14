-- RefreshToken 是热写表（每次登录 / 续签 / 登出都写），索引必须 CONCURRENTLY 建，
-- 否则建索引期间所有登录与续签都被挡住。本文件只放这一条语句、不含函数和 DO 块，
-- 让 Prisma 在事务外执行。部署后检查 pg_index.indisvalid；并发建索引中途失败时
-- 先手工 DROP 掉无效索引再重试。

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshToken_userId_deviceKey_idx"
ON "RefreshToken" ("userId", "deviceKey");
