-- 宣传期招新策略:担保票数快照源 + 成员邀请开关。
-- requiredVerifierCount 默认 1(拉人即进);后期收紧 UPDATE 成 10 即恢复满员担保。
ALTER TABLE "Circle" ADD COLUMN "requiredVerifierCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Circle" ADD COLUMN "memberCanInvite" BOOLEAN NOT NULL DEFAULT true;
