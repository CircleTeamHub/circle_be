-- 消息自动销毁全面改为默认关闭(0)。
--
-- 这个设置是查看者侧的读过滤(chat.service.ts selfDestructCutoff 往 where 里加
-- createdAt >= cutoff),不删库里的行。默认 2 天意味着用户只翻得到最近两天的聊天
-- 记录,而且没有任何报错或提示 —— 消息只是安静地消失。自毁是隐私功能,应当由
-- 用户主动开启。
ALTER TABLE "UserPrivacySetting" ALTER COLUMN "messageSelfDestructDays" SET DEFAULT 0;

-- 存量行全部归零,不区分取值来源。产品尚未上线,按「所有人都从关闭状态起步」处理。
-- 不可逆:显式选过 1 / 7 / 30 天的行也会被关掉,之后由用户自己在隐私设置页重开。
UPDATE "UserPrivacySetting" SET "messageSelfDestructDays" = 0;
