-- review 修复：报告唯一性收窄到 PENDING。
-- 硬唯一（reporter+target[+category]）在引入审核终态后变成「一辈子只能举报
-- 一次」：管理员驳回后，同一举报人对同一目标的新举报要么 409、要么静默改写
-- 已审结行的证据。改为局部唯一索引：任意时刻至多一条 PENDING（防刷队列），
-- 审结历史行可以无限累积。
DROP INDEX "GroupReport_reporterID_groupID_category_key";
CREATE INDEX "GroupReport_reporterID_groupID_category_idx"
  ON "GroupReport"("reporterID", "groupID", "category");
CREATE UNIQUE INDEX "GroupReport_pending_unique"
  ON "GroupReport"("reporterID", "groupID", "category")
  WHERE "status" = 'PENDING';

DROP INDEX "CirclePostReport_postID_reporterID_key";
CREATE INDEX "CirclePostReport_postID_reporterID_idx"
  ON "CirclePostReport"("postID", "reporterID");
CREATE UNIQUE INDEX "CirclePostReport_pending_unique"
  ON "CirclePostReport"("postID", "reporterID")
  WHERE "status" = 'PENDING';
