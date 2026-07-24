ALTER TABLE "User"
  DROP CONSTRAINT IF EXISTS "User_vipLevel_check";

UPDATE "User"
SET "vipLevel" = 4
WHERE "vipLevel" > 4;

DELETE FROM "UserDisplayIcon" vip5
USING "UserDisplayIcon" vip4
WHERE vip5."systemKey" = 'VIP'
  AND vip5."systemVariant" = 'VIP5'
  AND vip4."userID" = vip5."userID"
  AND vip4."systemKey" = 'VIP'
  AND vip4."systemVariant" = 'VIP4';

UPDATE "UserDisplayIcon"
SET "systemVariant" = 'VIP4'
WHERE "systemKey" = 'VIP'
  AND "systemVariant" = 'VIP5';

ALTER TABLE "User"
  ADD CONSTRAINT "User_vipLevel_check"
  CHECK ("vipLevel" >= 0 AND "vipLevel" <= 4);
