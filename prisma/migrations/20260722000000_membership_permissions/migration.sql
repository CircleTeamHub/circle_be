BEGIN;

CREATE TYPE "MembershipBenefitType" AS ENUM (
  'STANDARD_FANCY_NUMBER',
  'PREMIUM_FANCY_NUMBER'
);

ALTER TABLE "User"
  ADD COLUMN "vipExpiresAt" TIMESTAMP(3);

-- Normalize legacy values before making the new 0-4 contract enforceable.
UPDATE "User"
SET "vipLevel" = 4
WHERE "vipLevel" > 4;

UPDATE "Circle"
SET "joinVipRestriction" = CASE
  WHEN "joinVipRestriction" <= 0 THEN NULL
  WHEN "joinVipRestriction" > 4 THEN 4
  ELSE "joinVipRestriction"
END
WHERE "joinVipRestriction" IS NOT NULL
  AND ("joinVipRestriction" <= 0 OR "joinVipRestriction" > 4);

UPDATE "CirclePost"
SET "vipRestriction" = CASE
  WHEN "vipRestriction" <= 0 THEN NULL
  WHEN "vipRestriction" > 4 THEN 4
  ELSE "vipRestriction"
END
WHERE "vipRestriction" IS NOT NULL
  AND ("vipRestriction" <= 0 OR "vipRestriction" > 4);

UPDATE "CirclePost"
SET "signupVipRestriction" = CASE
  WHEN "signupVipRestriction" <= 0 THEN NULL
  WHEN "signupVipRestriction" > 4 THEN 4
  ELSE "signupVipRestriction"
END
WHERE "signupVipRestriction" IS NOT NULL
  AND ("signupVipRestriction" <= 0 OR "signupVipRestriction" > 4);

ALTER TABLE "User"
  ADD CONSTRAINT "User_vipLevel_check"
  CHECK ("vipLevel" BETWEEN 0 AND 4);

ALTER TABLE "Circle"
  ADD CONSTRAINT "Circle_joinVipRestriction_check"
  CHECK ("joinVipRestriction" IS NULL OR "joinVipRestriction" BETWEEN 1 AND 4);

ALTER TABLE "CirclePost"
  ADD CONSTRAINT "CirclePost_vipRestriction_check"
  CHECK ("vipRestriction" IS NULL OR "vipRestriction" BETWEEN 1 AND 4),
  ADD CONSTRAINT "CirclePost_signupVipRestriction_check"
  CHECK ("signupVipRestriction" IS NULL OR "signupVipRestriction" BETWEEN 1 AND 4);

CREATE TABLE "MembershipGrant" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "targetUserID" TEXT NOT NULL,
  "operatorUserID" TEXT NOT NULL,
  "previousLevel" INTEGER NOT NULL,
  "newLevel" INTEGER NOT NULL,
  "previousExpiresAt" TIMESTAMP(3),
  "newExpiresAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MembershipGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipGrant_previousLevel_check" CHECK ("previousLevel" BETWEEN 0 AND 4),
  CONSTRAINT "MembershipGrant_newLevel_check" CHECK ("newLevel" BETWEEN 1 AND 4)
);

CREATE TABLE "MembershipBenefitGrant" (
  "id" TEXT NOT NULL,
  "userID" TEXT NOT NULL,
  "membershipGrantID" TEXT NOT NULL,
  "type" "MembershipBenefitType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MembershipBenefitGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipGrant_idempotencyKey_key"
  ON "MembershipGrant"("idempotencyKey");
CREATE INDEX "MembershipGrant_targetUserID_createdAt_idx"
  ON "MembershipGrant"("targetUserID", "createdAt");
CREATE INDEX "MembershipGrant_operatorUserID_createdAt_idx"
  ON "MembershipGrant"("operatorUserID", "createdAt");
CREATE UNIQUE INDEX "MembershipBenefitGrant_userID_type_key"
  ON "MembershipBenefitGrant"("userID", "type");
CREATE INDEX "MembershipBenefitGrant_membershipGrantID_idx"
  ON "MembershipBenefitGrant"("membershipGrantID");

ALTER TABLE "MembershipGrant"
  ADD CONSTRAINT "MembershipGrant_targetUserID_fkey"
  FOREIGN KEY ("targetUserID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MembershipGrant"
  ADD CONSTRAINT "MembershipGrant_operatorUserID_fkey"
  FOREIGN KEY ("operatorUserID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MembershipBenefitGrant"
  ADD CONSTRAINT "MembershipBenefitGrant_userID_fkey"
  FOREIGN KEY ("userID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MembershipBenefitGrant"
  ADD CONSTRAINT "MembershipBenefitGrant_membershipGrantID_fkey"
  FOREIGN KEY ("membershipGrantID") REFERENCES "MembershipGrant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
