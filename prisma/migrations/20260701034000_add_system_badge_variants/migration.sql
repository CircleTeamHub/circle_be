-- System badges can have multiple selectable variants under the same key,
-- e.g. VIP1..VIP5 are all SystemIconKey.VIP.
ALTER TABLE "UserDisplayIcon" ADD COLUMN IF NOT EXISTS "systemVariant" TEXT;

UPDATE "UserDisplayIcon"
SET "systemVariant" = "systemKey"::text
WHERE "displayType" = 'SYSTEM'
  AND "systemKey" IS NOT NULL
  AND "systemVariant" IS NULL;

DROP INDEX IF EXISTS "UserDisplayIcon_userID_systemKey_key";

CREATE UNIQUE INDEX IF NOT EXISTS "UserDisplayIcon_userID_systemKey_systemVariant_key"
ON "UserDisplayIcon"("userID", "systemKey", "systemVariant");
