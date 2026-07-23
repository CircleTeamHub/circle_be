CREATE TYPE "RefreshTokenRevocationReason" AS ENUM (
  'ROTATED',
  'SINGLE_DEVICE_REPLACED',
  'LOGOUT',
  'LOGOUT_ALL',
  'SESSION_REVOKED',
  'OTHER_SESSIONS_REVOKED',
  'TOKEN_FAMILY_REUSE'
);

ALTER TABLE "RefreshToken"
ADD COLUMN "familyId" TEXT,
ADD COLUMN "revocationReason" "RefreshTokenRevocationReason";

-- Existing rows cannot be linked into their historical rotation chains
-- reliably. Giving each row its own family fails closed without allowing an
-- old revoked token to terminate a newer, unrelated session.
UPDATE "RefreshToken"
SET "familyId" = "id"
WHERE "familyId" IS NULL;

ALTER TABLE "RefreshToken"
ALTER COLUMN "familyId" SET NOT NULL,
ALTER COLUMN "familyId" SET DEFAULT gen_random_uuid()::text;

CREATE INDEX "RefreshToken_userId_familyId_idx"
ON "RefreshToken"("userId", "familyId");

CREATE INDEX "RefreshToken_userId_audience_createdAt_idx"
ON "RefreshToken"("userId", "audience", "createdAt");
