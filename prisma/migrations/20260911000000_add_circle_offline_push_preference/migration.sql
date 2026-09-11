-- 圈子通知「离线提醒」的用户级开关。
--
-- 加性迁移：带默认值的新列，旧版本后端不读它、写入也不受影响，可以先上库再发版。
-- 默认 true 保持既有行为（此前推送服务不读任何用户偏好，所有人都收 CIRCLE_* 推送）。
ALTER TABLE "User"
  ADD COLUMN "circleOfflinePushEnabled" BOOLEAN NOT NULL DEFAULT true;
