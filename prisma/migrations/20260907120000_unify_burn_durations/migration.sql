-- 阅后即焚的时长阶梯合并成一张表(src/common/burn-durations.ts):
--   1/5/10/30 分钟、1/2/6 小时、1–6 天、1–3 周、1 个月。
--
-- 在这之前同一个功能有两张互不相同的档位表:会话级焚毁是秒数白名单
-- (30秒/5分/1时/1天/7天),全局隐私设置是**天数**白名单(1/2/7/30 天)。
-- 于是「10 分钟」只有单会话里有,「30 天」只有全局里有,用户在两个入口看到的
-- 是两个看起来无关的功能。

-- 1) 全局设置从「天」改存「秒」。
--
-- expand/contract:新增列 + 回填,不动旧列 —— 蓝绿窗口里旧二进制仍在读写
-- messageSelfDestructDays,把它删掉或改名会让那段窗口里的隐私设置整个 500。
-- 旧列由后续版本删除。回滚到旧二进制时,用户在本版期间改过的全局档位会回到
-- 迁移前的天数值(旧列没有跟着写),这是这次 expand 的已知取舍。
ALTER TABLE "UserPrivacySetting"
  ADD COLUMN IF NOT EXISTS "messageSelfDestructSec" INTEGER NOT NULL DEFAULT 0;

UPDATE "UserPrivacySetting"
SET "messageSelfDestructSec" = "messageSelfDestructDays" * 86400
WHERE "messageSelfDestructDays" > 0
  AND "messageSelfDestructSec" = 0;

-- 2) 会话级唯一的孤儿档位 30 秒 → 1 分钟(新表里最短的一档)。
--
-- 不迁的话这些会话在选择面板里会一个档位都不高亮,用户只能重选一次。
-- 焚毁清扫器本来就是每分钟一轮(ChatBurnSweeperService),30 秒的设置实际生效
-- 粒度从来就不小于一分钟 —— 这次改动没有让任何一条消息比原先多活一整轮。
-- 其余旧档位(300 / 3600 / 86400 / 604800)在新表里原样保留,无需迁移。
UPDATE "ChatConversation"
SET "burnDurationSec" = 60
WHERE "burnDurationSec" = 30;
