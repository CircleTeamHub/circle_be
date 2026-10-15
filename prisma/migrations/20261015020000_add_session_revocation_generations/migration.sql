-- Store a version snapshot on each refresh-token row. Existing rows belong to
-- generation zero and remain valid until their scope is incremented.
ALTER TABLE "RefreshToken"
ADD COLUMN "accountGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "audienceGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "deviceGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "familyGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "SessionRevocationScope" AS ENUM (
  'ACCOUNT',
  'AUDIENCE',
  'DEVICE',
  'FAMILY'
);

CREATE TABLE "SessionScopeGeneration" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scope" "SessionRevocationScope" NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "exemptFamilyId" TEXT,
  "notificationPending" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SessionScopeGeneration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SessionScopeGeneration_userId_scope_scopeKey_key"
ON "SessionScopeGeneration"("userId", "scope", "scopeKey");

CREATE INDEX "SessionScopeGeneration_userId_idx"
ON "SessionScopeGeneration"("userId");

CREATE INDEX "SessionScopeGeneration_notificationPending_updatedAt_idx"
ON "SessionScopeGeneration"("notificationPending", "updatedAt");

ALTER TABLE "SessionScopeGeneration"
ADD CONSTRAINT "SessionScopeGeneration_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
