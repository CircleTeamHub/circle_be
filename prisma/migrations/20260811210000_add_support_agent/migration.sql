-- CreateEnum
CREATE TYPE "SupportAgentCategory" AS ENUM ('recharge', 'issue', 'dispute', 'account', 'membership');

-- CreateTable
CREATE TABLE "SupportAgent" (
    "id" TEXT NOT NULL,
    "category" "SupportAgentCategory" NOT NULL,
    "userID" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportAgent_category_userID_key" ON "SupportAgent"("category", "userID");

-- CreateIndex
CREATE INDEX "SupportAgent_category_enabled_sortOrder_idx" ON "SupportAgent"("category", "enabled", "sortOrder");

-- AddForeignKey
ALTER TABLE "SupportAgent" ADD CONSTRAINT "SupportAgent_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
