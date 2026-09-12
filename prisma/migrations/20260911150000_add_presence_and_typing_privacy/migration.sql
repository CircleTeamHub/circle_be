-- 隐私设置补三项:显示在线时间、单聊输入状态、群聊输入状态。
--
-- 三项默认 true:上线前在线状态与「正在输入」本来就对所有会话成员可见,
-- 默认收紧等于替存量用户全体改了行为。想藏的人自己去隐私页关。
-- 加列带默认值即可,不需要回填;没有隐私行的用户走 DEFAULT_PRIVACY_SETTINGS
-- 里同一份默认值(见 privacy-settings.service.ts)。
ALTER TABLE "UserPrivacySetting"
  ADD COLUMN IF NOT EXISTS "shareOnlineStatus" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "shareTypingInDirect" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "shareTypingInGroup" BOOLEAN NOT NULL DEFAULT true;
