-- G-07 能力面：送达水位 / 消息编辑留痕 / 表情回应。
ALTER TABLE "ChatMember" ADD COLUMN "lastDeliveredHeight" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatMessage" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN "contentHistory" JSONB;

CREATE TABLE "ChatMessageReaction" (
    "id" TEXT NOT NULL,
    "messageID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessageReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatMessageReaction_messageID_userID_emoji_key"
  ON "ChatMessageReaction"("messageID", "userID", "emoji");
CREATE INDEX "ChatMessageReaction_messageID_idx" ON "ChatMessageReaction"("messageID");

ALTER TABLE "ChatMessageReaction"
  ADD CONSTRAINT "ChatMessageReaction_messageID_fkey"
  FOREIGN KEY ("messageID") REFERENCES "ChatMessage"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
