ALTER TABLE "ChatMember" ADD COLUMN "burnDurationSec" INTEGER,
  ADD COLUMN "burnStartedAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN "burnDurationSec" INTEGER,
  ADD COLUMN "burnExpiresAt" TIMESTAMP(3);
CREATE INDEX "ChatMessage_burn_expiry_active_idx" ON "ChatMessage" ("conversationID", "burnExpiresAt")
  WHERE "deleted" = false AND "burnExpiresAt" IS NOT NULL;
-- The old shared setting has no reliable author. Do not assign it to either member
-- or retroactively expire either sender's history. Both members opt in independently.
UPDATE "ChatConversation" SET "burnDurationSec" = NULL, "burnStartedAt" = NULL
  WHERE "burnDurationSec" IS NOT NULL OR "burnStartedAt" IS NOT NULL;
