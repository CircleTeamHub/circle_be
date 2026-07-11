ALTER TABLE "DevicePushToken"
  ADD COLUMN IF NOT EXISTS "revocationSecretHash" TEXT;
