-- 宣传期招新策略:担保票数快照源 + 成员邀请开关。
-- requiredVerifierCount 默认 1(拉人即进);后期收紧 UPDATE 成 10 即恢复满员担保。
ALTER TABLE "Circle" ADD COLUMN "requiredVerifierCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Circle" ADD COLUMN "memberCanInvite" BOOLEAN NOT NULL DEFAULT true;

-- 蓝绿发布窗口:迁移落地后、旧色被换掉之前,旧代码建担保单不传 requiredCount,
-- 会吃到这一列原来的默认值 10 —— 而圈子此刻已经写着 requiredVerifierCount=1,
-- 那批单子会永久停在「要十票」上。把列默认一并对齐,窗口内的行为就与新策略一致。
-- 新代码两条建单路径都显式传值,这个默认只对旧色有意义。
ALTER TABLE "CircleInvitation" ALTER COLUMN "requiredCount" SET DEFAULT 1;
