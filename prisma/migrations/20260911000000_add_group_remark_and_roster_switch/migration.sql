-- 群备注 + 「是否显示群成员」开关。
--
-- 1) ChatMember.remark:我给这个群起的名字,**只有我看得见**,对应单聊的好友备注。
--    与同一张表上的 alias 正好相反(alias 是我给自己起的名字、全群可见),
--    也与 ChatConversation.name / Circle.name 无关(那是全群共享的群名)。
--    可空列,null 即「未设置」,不需要回填。
ALTER TABLE "ChatMember"
  ADD COLUMN IF NOT EXISTS "remark" TEXT;

-- 2) ChatConversation.membersCanViewRoster:普通成员能否看到群成员名单。
--
-- DEFAULT 是「关」,与 membersCanViewProfiles 同一条理由:圈子群的成员目录此前是
-- 硬门槛(只有圈主/管理员看得到,listMembers 直接 403)。DEFAULT true + 一次性回填
-- 的写法在蓝绿窗口里有洞 —— 回填之后老 pod 建出来的圈子会话会永久拿着 open 默认。
-- 定成 false 则漏网的行只会更严,群主自己能打开。
ALTER TABLE "ChatConversation"
  ADD COLUMN IF NOT EXISTS "membersCanViewRoster" BOOLEAN NOT NULL DEFAULT false;

-- (单独再写一次 DEFAULT:给已经跑过本迁移旧版本的库纠正回来。)
ALTER TABLE "ChatConversation"
  ALTER COLUMN "membersCanViewRoster" SET DEFAULT false;

-- 独立群聊(微信群语义)本来就是全员可见名单:回填成开,保持现状。
-- 圈子会话什么都不做 —— 默认已经是关。
UPDATE "ChatConversation"
SET "membersCanViewRoster" = true
WHERE "circleID" IS NULL;
