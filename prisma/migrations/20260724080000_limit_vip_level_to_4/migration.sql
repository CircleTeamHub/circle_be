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

-- 圈子/帖子的 VIP 门槛也一并夹到 4：收口后不存在 vipLevel>4 的用户，原本配 VIP5+ 的
-- 加入/互动/报名门槛将无人能满足、内容永久不可达，故把这些历史门槛降到顶档 super(4)。
UPDATE "Circle"
SET "joinVipRestriction" = 4
WHERE "joinVipRestriction" > 4;

UPDATE "CirclePost"
SET "vipRestriction" = 4
WHERE "vipRestriction" > 4;

UPDATE "CirclePost"
SET "signupVipRestriction" = 4
WHERE "signupVipRestriction" > 4;
