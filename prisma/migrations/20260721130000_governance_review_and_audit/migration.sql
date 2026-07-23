-- #92: make group / circle-post reports actionable; #90: admin audit log.
CREATE TYPE "ReportReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "GroupReport" ADD COLUMN "status" "ReportReviewStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "GroupReport" ADD COLUMN "reviewedByID" TEXT;
ALTER TABLE "GroupReport" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "GroupReport" ADD COLUMN "reviewNote" TEXT;
CREATE INDEX "GroupReport_status_createdAt_idx" ON "GroupReport"("status", "createdAt");

ALTER TABLE "CirclePostReport" ADD COLUMN "status" "ReportReviewStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "CirclePostReport" ADD COLUMN "reviewedByID" TEXT;
ALTER TABLE "CirclePostReport" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "CirclePostReport" ADD COLUMN "reviewNote" TEXT;
ALTER TABLE "CirclePostReport" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "CirclePostReport_status_createdAt_idx" ON "CirclePostReport"("status", "createdAt");

CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorID" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityID" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAuditLog_actorID_createdAt_idx" ON "AdminAuditLog"("actorID", "createdAt");
CREATE INDEX "AdminAuditLog_entityType_entityID_createdAt_idx" ON "AdminAuditLog"("entityType", "entityID", "createdAt");
