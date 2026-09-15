ALTER TABLE "ChatMessage"
ADD COLUMN "deletedAt" TIMESTAMP(3);

UPDATE "ChatMessage"
SET "deletedAt" = CURRENT_TIMESTAMP
WHERE "deleted" = true;

CREATE INDEX "ChatMessage_conversationID_deletedAt_idx"
ON "ChatMessage"("conversationID", "deletedAt");
