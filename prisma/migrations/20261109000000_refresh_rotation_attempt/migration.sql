-- 续签尝试 ID:结果没送到客户端时,客户端带同一 ID 重试,服务端据此区分「重试」和「令牌被盗重放」。
-- 只加可空列,不改已有数据,不需要回填。查询走已有的 (userId, familyId) 索引,不加新索引。
--
-- RefreshToken 是每次续签都要写的热表:可空加列只改目录,但要拿 ACCESS EXCLUSIVE。等不到
-- 5 秒就整份回滚,别让排队的锁把所有续签堵住。失败时先
-- `npx prisma migrate resolve --rolled-back 20261109000000_refresh_rotation_attempt`,
-- 避开长事务后重跑 migrate deploy。
SET lock_timeout = '5s';

ALTER TABLE "RefreshToken" ADD COLUMN "rotationAttemptId" TEXT;
