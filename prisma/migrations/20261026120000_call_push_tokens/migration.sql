-- 推送来电（docs/superpowers/specs/2026-10-26-push-incoming-calls-design.md，circle-im 仓库）。
--
-- callPushVersion：客户端登记 token 时声明自己能处理的来电推送协议版本。旧客户端不带，
-- 列为 null —— 它们收到透传 / VoIP 推送也不会响铃，所以后端只给 >= 1 的设备发。
-- apnsEnvironment：仅 provider = 'apns_voip'。TestFlight / App Store 包走 production，
-- Xcode 调试包走 development；同一个后端要能同时服务两种包，只能按 token 记。
--
-- 两列都是可空、无默认值的 ADD COLUMN：只改目录，不重写表。
ALTER TABLE "DevicePushToken" ADD COLUMN "callPushVersion" INTEGER;
ALTER TABLE "DevicePushToken" ADD COLUMN "apnsEnvironment" TEXT;
