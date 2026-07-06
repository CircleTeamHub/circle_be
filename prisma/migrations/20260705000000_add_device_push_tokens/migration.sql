CREATE TABLE "DevicePushToken" (
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

CREATE UNIQUE INDEX "DevicePushToken_token_key" ON "DevicePushToken"("token");

CREATE INDEX "DevicePushToken_userID_idx" ON "DevicePushToken"("userID");

CREATE INDEX "DevicePushToken_provider_platform_idx"
  ON "DevicePushToken"("provider", "platform");

ALTER TABLE "DevicePushToken"
  ADD CONSTRAINT "DevicePushToken_userID_fkey"
  FOREIGN KEY ("userID") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
