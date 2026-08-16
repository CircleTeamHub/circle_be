-- 独立群聊（不挂圈子的 GROUP 会话）：群名 + 群主。
ALTER TABLE "ChatConversation" ADD COLUMN "name" TEXT;
ALTER TABLE "ChatConversation" ADD COLUMN "ownerID" TEXT;
