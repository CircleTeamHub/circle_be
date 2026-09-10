-- 群备注 + 「是否显示群成员」开关。
--
-- 1) ChatMember.remark:我给这个群起的名字,**只有我看得见**,对应单聊的好友备注。
--    与同一张表上的 alias 正好相反(alias 是我给自己起的名字、全群可见),
--    也与 ChatConversation.name / Circle.name 无关(那是全群共享的群名)。
--    可空列,null 即「未设置」,不需要回填。
ALTER TABLE "ChatMember"
  ADD COLUMN IF NOT EXISTS "remark" TEXT;

-- 2) ChatConversation.membersCanViewRoster:普通成员能否看到群成员名单。
ALTER TABLE "ChatConversation"
  ADD COLUMN IF NOT EXISTS "membersCanViewRoster" BOOLEAN NOT NULL DEFAULT true;

-- 圈子群的成员目录此前是硬门槛:只有圈主/管理员看得到(listMembers 直接 403)。
-- 新开关默认 true,不回填的话这次上线等于把每个存量圈子的成员名单对全员放开 ——
-- 与 membersCanViewProfiles 同一条理由,存量圈子会话一律回填成关闭,
-- 由圈主自己决定开。独立群聊保持默认开(它本来就是全员可见)。
UPDATE "ChatConversation"
SET "membersCanViewRoster" = false
WHERE "circleID" IS NOT NULL;
