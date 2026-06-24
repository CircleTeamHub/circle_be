-- CreateTable
CREATE TABLE "GroupReport" (
    "id" TEXT NOT NULL,
    "reporterID" TEXT NOT NULL,
    "groupID" TEXT NOT NULL,
    "circleID" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupReport_reporterID_groupID_category_key" ON "GroupReport"("reporterID", "groupID", "category");

-- CreateIndex
CREATE INDEX "GroupReport_reporterID_createdAt_idx" ON "GroupReport"("reporterID", "createdAt");

-- CreateIndex
CREATE INDEX "GroupReport_groupID_createdAt_idx" ON "GroupReport"("groupID", "createdAt");

-- CreateIndex
CREATE INDEX "GroupReport_circleID_createdAt_idx" ON "GroupReport"("circleID", "createdAt");

-- AddForeignKey
ALTER TABLE "GroupReport" ADD CONSTRAINT "GroupReport_reporterID_fkey" FOREIGN KEY ("reporterID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupReport" ADD CONSTRAINT "GroupReport_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
