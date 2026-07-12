-- CreateTable
CREATE TABLE "CirclePostReport" (
    "id" TEXT NOT NULL,
    "postID" TEXT NOT NULL,
    "reporterID" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CirclePostReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CirclePostReport_postID_reporterID_key" ON "CirclePostReport"("postID", "reporterID");

-- CreateIndex
CREATE INDEX "CirclePostReport_postID_idx" ON "CirclePostReport"("postID");
