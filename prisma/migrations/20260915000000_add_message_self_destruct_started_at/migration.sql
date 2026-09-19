-- 全局阅后即焚(UserPrivacySetting.messageSelfDestructSec)一直只有窗口下沿、
-- 没有开启边界:打开开关的那一刻,此前的全部历史对本人一次性不可见。会话级
-- 焚毁在 20260914010000 已经补过同样的边界,这里把查看者侧对齐。
ALTER TABLE "UserPrivacySetting"
ADD COLUMN "messageSelfDestructStartedAt" TIMESTAMP(3);

-- 存量已开启的用户没有可信的开启时间点(updatedAt 会被任何一次设置修改覆盖),
-- 因此与 20260914010000 取同一个口径:把迁移执行时刻当作边界。副作用是这些
-- 用户此前被隐藏的历史重新可见 —— 这正是本次修复要恢复的状态。
UPDATE "UserPrivacySetting"
SET "messageSelfDestructStartedAt" = CURRENT_TIMESTAMP
WHERE "messageSelfDestructSec" > 0;
