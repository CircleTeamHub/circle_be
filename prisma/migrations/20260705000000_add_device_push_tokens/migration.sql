-- Idempotent for the existing-DB baseline-reset runbook
-- (db push -> resolve 0_init -> migrate deploy).
CREATE TABLE IF NOT EXISTS "DevicePushToken" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "projectId" TEXT,
  "appVersion" TEXT,
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "userID" TEXT NOT NULL,

  CONSTRAINT "DevicePushToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DevicePushToken_token_key" ON "DevicePushToken"("token");

CREATE INDEX IF NOT EXISTS "DevicePushToken_userID_idx" ON "DevicePushToken"("userID");

CREATE INDEX IF NOT EXISTS "DevicePushToken_provider_platform_idx"
  ON "DevicePushToken"("provider", "platform");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DevicePushToken_userID_fkey') THEN
    ALTER TABLE "DevicePushToken"
      ADD CONSTRAINT "DevicePushToken_userID_fkey"
      FOREIGN KEY ("userID") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
