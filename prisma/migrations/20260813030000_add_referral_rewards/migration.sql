-- Referral rewards start from this migration forward. Existing
-- User.invitedByUserId relationships are intentionally not backfilled because
-- they predate the qualification and anti-abuse rules.
CREATE TYPE "ReferralStatus" AS ENUM (
  'PENDING',
  'REWARDED',
  'CAPPED',
  'REJECTED',
  'EXPIRED'
);

-- 新增两个 CoinTxType 取值。回滚下限随之抬高(deploy/SCHEMA_COMPATIBILITY 2 → 3):
-- 一旦结算写出 REFERRAL_REWARD / REFERRAL_BONUS,回滚到旧二进制时它生成的 Prisma
-- 枚举里没有这两个值,GET /coin/transactions 会在反序列化时炸掉——受影响的正是
-- 刚拿到奖励的用户。抬高 floor 之后 release-deploy 会直接拒绝回滚到那些镜像,
-- 而不是把这个故障留到线上被用户撞见。
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'REFERRAL_REWARD';
ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'REFERRAL_BONUS';

CREATE TABLE "Referral" (
  "id" TEXT NOT NULL,
  "inviterID" TEXT NOT NULL,
  "inviteeID" TEXT NOT NULL,
  "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
  "inviterReward" INTEGER NOT NULL,
  "inviteeReward" INTEGER NOT NULL,
  "eligibleAt" TIMESTAMP(3) NOT NULL,
  "nextCheckAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "qualifiedAt" TIMESTAMP(3),
  "rewardedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Referral_inviteeID_key" ON "Referral"("inviteeID");
CREATE INDEX "Referral_status_nextCheckAt_idx" ON "Referral"("status", "nextCheckAt");
CREATE INDEX "Referral_inviterID_rewardedAt_idx" ON "Referral"("inviterID", "rewardedAt");
CREATE INDEX "Referral_inviterID_createdAt_idx" ON "Referral"("inviterID", "createdAt");

ALTER TABLE "Referral"
ADD CONSTRAINT "Referral_inviterID_fkey"
FOREIGN KEY ("inviterID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Referral"
ADD CONSTRAINT "Referral_inviteeID_fkey"
FOREIGN KEY ("inviteeID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
