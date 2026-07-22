-- 治理审计（20260721130000_governance_review_and_audit）已经建好 AdminAuditLog。
-- 管理台用户中心复用同一张表，这里只补它额外需要的列，以及按操作类型检索的索引；
-- actorID / entityType / entityID 与既有治理写入完全共用。
ALTER TABLE "AdminAuditLog"
    ADD COLUMN "actorAccountId" TEXT,
    ADD COLUMN "reason" TEXT,
    ADD COLUMN "metadata" JSONB,
    ADD COLUMN "requestId" TEXT;

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx"
ON "AdminAuditLog"("action", "createdAt");
