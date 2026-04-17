-- CreateTable
CREATE TABLE "FriendReport" (
    "id" TEXT NOT NULL,
    "reporterID" TEXT NOT NULL,
    "targetID" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FriendReport_reporterID_createdAt_idx" ON "FriendReport"("reporterID", "createdAt");

-- CreateIndex
CREATE INDEX "FriendReport_targetID_createdAt_idx" ON "FriendReport"("targetID", "createdAt");

-- AddForeignKey
ALTER TABLE "FriendReport" ADD CONSTRAINT "FriendReport_reporterID_fkey" FOREIGN KEY ("reporterID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendReport" ADD CONSTRAINT "FriendReport_targetID_fkey" FOREIGN KEY ("targetID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
