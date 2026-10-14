ALTER TABLE "DevicePushToken" ADD COLUMN "deviceKey" TEXT;
CREATE INDEX "DevicePushToken_userID_deviceKey_idx" ON "DevicePushToken"("userID", "deviceKey");
