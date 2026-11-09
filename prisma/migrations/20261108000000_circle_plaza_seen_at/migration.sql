-- 圈子帖子列表的 tab 红点：记录用户最后一次打开列表的时间。
--
-- 加性迁移：默认值走 PostgreSQL 的 fast default，不重写表；旧版本后端不读它。
-- 默认当前时间，上线时已有的帖子不会点亮红点。
-- User 是热表：拿不到锁就失败重来，不排在长事务后面把所有读写一起堵住。
SET lock_timeout = '5s';

ALTER TABLE "User"
  ADD COLUMN "circlePlazaSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

RESET lock_timeout;
