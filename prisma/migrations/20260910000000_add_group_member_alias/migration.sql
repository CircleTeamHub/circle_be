-- 群昵称(群备注):本人在某个群里的显示名,对全群可见;null = 用账号昵称。
--
-- 与好友备注区分:好友备注是「我给对方起的名字、只有我看得见」(Friend.remark),
-- 这个是「我给自己起的名字、群里所有人看见」。两者并存,展示时好友备注优先。
--
-- 纯 expand:一个可空列,没有默认值也不需要回填(null 即「未设置」)。
-- 旧二进制不认识它,不参与它的 select/insert,蓝绿窗口照常;不抬 SCHEMA_COMPATIBILITY。
ALTER TABLE "ChatMember"
  ADD COLUMN IF NOT EXISTS "alias" TEXT;
