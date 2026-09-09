-- 群设置第二批(circle-im/docs/superpowers/specs/2026-09-09-group-settings-batch2-design.md):
-- 独立群公告/头像,进群允许方式(成员邀请/二维码),成员权限(查看资料/加好友)。
--
-- 纯 expand:带默认值的新列 + 一条回填。旧二进制不认识这些列,不参与它的 select/insert,
-- 蓝绿窗口照常;不抬 SCHEMA_COMPATIBILITY。
ALTER TABLE "ChatConversation"
  ADD COLUMN IF NOT EXISTS "notice" TEXT,
  ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "memberCanInvite" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "qrJoinEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "membersCanViewProfiles" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "membersCanAddFriends" BOOLEAN NOT NULL DEFAULT true;

-- 圈子群的成员目录原本只对圈主/管理员开放(review R2 的隐私设计),「成员可查看他人资料」
-- 默认必须延续这条线:存量圈子会话回填成关闭,由圈主自己决定放开。独立群聊保持默认开。
UPDATE "ChatConversation"
SET "membersCanViewProfiles" = false
WHERE "circleID" IS NOT NULL;
