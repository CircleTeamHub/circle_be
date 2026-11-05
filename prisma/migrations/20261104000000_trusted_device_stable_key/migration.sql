-- 纯加性：老安卓安装的稳定设备 ID 别名（sha256）。
ALTER TABLE "TrustedDevice" ADD COLUMN "stableDeviceKey" TEXT;
