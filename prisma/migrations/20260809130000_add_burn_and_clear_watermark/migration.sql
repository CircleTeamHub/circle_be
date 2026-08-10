-- S-01 会话级阅后即焚 + G-14 清空聊天记录水位。
ALTER TABLE "ChatConversation" ADD COLUMN "burnDurationSec" INTEGER;
ALTER TABLE "ChatMember" ADD COLUMN "clearedBeforeHeight" INTEGER NOT NULL DEFAULT 0;
