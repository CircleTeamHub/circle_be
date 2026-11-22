-- 拉黑时快照拉黑者给对方的好友备注(拉黑会删掉好友关系,备注随之消失)。
-- 可空列、无默认值:PostgreSQL 只改目录,不重写表、不长时间持锁。
ALTER TABLE "Block" ADD COLUMN "remark" TEXT;
