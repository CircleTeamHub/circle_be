-- 消息自动销毁默认由 2 天改为关闭(0)。
--
-- 这个设置是查看者侧的读过滤(chat.service.ts selfDestructCutoff 往 where 里加
-- createdAt >= cutoff),不删库里的行。默认 2 天意味着所有从没进过隐私设置的用户
-- 都只翻得到最近两天的聊天记录,而且没有任何报错或提示 —— 消息只是安静地消失。
-- 自毁是隐私功能,应当由用户主动开启。
ALTER TABLE "UserPrivacySetting" ALTER COLUMN "messageSelfDestructDays" SET DEFAULT 0;

-- 存量行里的 2 一并归零。无法区分「显式选了 2 天」和「建行时吃到旧列默认值」——
-- 两者在库里完全一样。产品尚未上线,不存在需要保留的真实用户选择,因此按后者处理:
-- 宁可把一个几乎没人主动做过的选择重置掉,也不留下一批仍在静默吞历史的账号。
-- 其余取值(1 / 7 / 30)只可能来自显式设置,不动。
UPDATE "UserPrivacySetting" SET "messageSelfDestructDays" = 0 WHERE "messageSelfDestructDays" = 2;
