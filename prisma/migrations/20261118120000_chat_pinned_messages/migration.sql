-- 消息置顶改成一个会话多条(最多 5 条):置顶移到单独的表,把会话行上现有的那一条搬过来。
--
-- 只做 expand:ChatConversation 上的 pinnedMessage* 五列保留不动。蓝绿发布时旧版本仍在服务,
-- 它会读写这几列;新版本只读写新表。下一个版本再删旧列。
--
-- 加外键要在 ChatConversation(发消息路径上 FOR UPDATE 的热表)上拿 SHARE ROW EXCLUSIVE,
-- 新表是空的、校验瞬间完成,但等锁可能排在长事务后面:等不到 5 秒就整份回滚,
-- 别让排队的锁把所有发送堵住。失败时先
-- `npx prisma migrate resolve --rolled-back 20261118120000_chat_pinned_messages`,
-- 避开长事务后重跑 migrate deploy。
SET lock_timeout = '5s';

CREATE TABLE "ChatPinnedMessage" (
    "conversationID" TEXT NOT NULL,
    "messageID" TEXT NOT NULL,
    "height" INTEGER NOT NULL,
    "preview" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinnedByID" TEXT NOT NULL,
    CONSTRAINT "ChatPinnedMessage_pkey" PRIMARY KEY ("conversationID", "messageID")
);

ALTER TABLE "ChatPinnedMessage" ADD CONSTRAINT "ChatPinnedMessage_conversationID_fkey"
    FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ChatPinnedMessage" ("conversationID", "messageID", "height", "preview", "pinnedAt", "pinnedByID")
SELECT "id",
       "pinnedMessageID",
       "pinnedMessageHeight",
       COALESCE("pinnedMessagePreview", ''),
       COALESCE("pinnedMessageAt", CURRENT_TIMESTAMP),
       COALESCE("pinnedMessageByID", '')
FROM "ChatConversation"
WHERE "pinnedMessageID" IS NOT NULL
  AND "pinnedMessageHeight" IS NOT NULL;

RESET lock_timeout;
