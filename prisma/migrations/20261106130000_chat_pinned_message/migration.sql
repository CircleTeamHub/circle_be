-- 消息置顶:一个会话一条。只加可空列,不改已有数据,不需要回填。
--
-- ChatConversation 是发消息路径上 FOR UPDATE 的热表:可空加列只改目录,但要拿
-- ACCESS EXCLUSIVE。等不到 5 秒就整份回滚,别让排队的锁把所有发送堵住。失败时先
-- `npx prisma migrate resolve --rolled-back 20261106130000_chat_pinned_message`,
-- 避开长事务后重跑 migrate deploy。
SET lock_timeout = '5s';

ALTER TABLE "ChatConversation"
  ADD COLUMN "pinnedMessageID" TEXT,
  ADD COLUMN "pinnedMessageHeight" INTEGER,
  ADD COLUMN "pinnedMessagePreview" TEXT,
  ADD COLUMN "pinnedMessageAt" TIMESTAMP(3),
  ADD COLUMN "pinnedMessageByID" TEXT;

RESET lock_timeout;
