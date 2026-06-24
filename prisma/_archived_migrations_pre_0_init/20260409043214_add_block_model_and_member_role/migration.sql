-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'MEMBER';

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "blockerID" TEXT NOT NULL,
    "blockedID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Block_blockerID_idx" ON "Block"("blockerID");

-- CreateIndex
CREATE INDEX "Block_blockedID_idx" ON "Block"("blockedID");

-- CreateIndex
CREATE UNIQUE INDEX "Block_blockerID_blockedID_key" ON "Block"("blockerID", "blockedID");

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockerID_fkey" FOREIGN KEY ("blockerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockedID_fkey" FOREIGN KEY ("blockedID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
