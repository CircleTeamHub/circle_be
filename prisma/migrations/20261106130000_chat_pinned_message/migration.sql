-- 消息置顶:一个会话一条。只加可空列,不改已有数据,不需要回填。
ALTER TABLE "ChatConversation"
  ADD COLUMN "pinnedMessageID" TEXT,
  ADD COLUMN "pinnedMessageHeight" INTEGER,
  ADD COLUMN "pinnedMessagePreview" TEXT,
  ADD COLUMN "pinnedMessageAt" TIMESTAMP(3),
  ADD COLUMN "pinnedMessageByID" TEXT;
