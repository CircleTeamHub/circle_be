ALTER TABLE "ChatConversation"
ADD COLUMN "burnStartedAt" TIMESTAMP(3);

-- Existing enabled conversations predate a durable activation boundary. Treat
-- deployment as the start so historical messages are never retroactively lost.
UPDATE "ChatConversation"
SET "burnStartedAt" = CURRENT_TIMESTAMP
WHERE "burnDurationSec" IS NOT NULL;
