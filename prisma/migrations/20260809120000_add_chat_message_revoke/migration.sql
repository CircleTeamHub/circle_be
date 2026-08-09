-- G-02 消息撤回：撤回的消息仍占 height，content 清空，媒体对象一并删除。
ALTER TABLE "ChatMessage" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN "revokedBy" TEXT;
