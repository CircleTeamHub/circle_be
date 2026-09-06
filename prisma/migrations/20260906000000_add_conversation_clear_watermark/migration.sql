-- 「删除所有人的记录」的会话级水位。
-- 此前全群清空只推进当时在座成员的 ChatMember.clearedBeforeHeight，新座位建出来是
-- 默认 0，于是清空之后拉一个新号进群就能读回全部历史。新座位继承这一列，读路径
-- 也按 max(座位水位, 会话水位) 兜底。
--
-- 回填 0 是有意的：这一列的语义是「曾经被全群清空到哪」，历史上没执行过全群清空
-- 的会话就是 0，与新建会话一致。已执行过的旧清空只留在各座位水位上，那些座位
-- 不受影响；补不回来的只有「那次清空之后、本次迁移之前入座的人」，无法从现有数据
-- 重建，也不该猜。
ALTER TABLE "ChatConversation"
ADD COLUMN "clearedBeforeHeight" INTEGER NOT NULL DEFAULT 0;
