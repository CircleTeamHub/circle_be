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
  ADD COLUMN IF NOT EXISTS "membersCanViewProfiles" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "membersCanAddFriends" BOOLEAN NOT NULL DEFAULT true;

-- DEFAULT 必须是「关」:圈子群的成员目录原本只对圈主/管理员开放(review R2 的隐私设计)。
-- 把 DEFAULT 定成 true + 一次性回填 false 的写法在蓝绿窗口里是有洞的 —— 回填跑完之后、
-- 老 pod 退役之前,老二进制的 ChatCircleSyncService 建出来的圈子会话仍会拿到 open 默认,
-- 而回填不会再跑第二次,那个圈子的成员资料就**永久**对全员开放。
-- 反过来定成 false 则怎么都只会「更严」:漏网的行是关着的,群主自己能打开。
-- (ALTER COLUMN 单独再写一次:给已经跑过本迁移旧版本的库把 DEFAULT 纠正回来。)
ALTER TABLE "ChatConversation"
  ALTER COLUMN "membersCanViewProfiles" SET DEFAULT false;

-- 独立群聊(微信群语义)本来就是「谁都能点开谁」:回填成开,保持现状。
UPDATE "ChatConversation"
SET "membersCanViewProfiles" = true
WHERE "circleID" IS NULL;
