-- A rejected report should free the (reporter, target, category) slot so the
-- reporter can file again for a genuine future incident. Replace the plain
-- unique index with a partial one that only constrains non-REJECTED reports.
DROP INDEX IF EXISTS "FriendReport_reporterID_targetID_category_key";

CREATE UNIQUE INDEX IF NOT EXISTS "FriendReport_active_report_key"
  ON "FriendReport"("reporterID", "targetID", "category")
  WHERE "status" <> 'REJECTED';
