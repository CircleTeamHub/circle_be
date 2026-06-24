-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CircleActivityType" ADD VALUE 'POST_SIGNUP_RECEIVED';
ALTER TYPE "CircleActivityType" ADD VALUE 'POST_SIGNUP_CONFIRMED';

-- AlterTable
ALTER TABLE "CirclePost" ADD COLUMN     "signupCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CircleActivity" ADD COLUMN     "postID" TEXT;

-- CreateTable
CREATE TABLE "CirclePostSignup" (
    "id" TEXT NOT NULL,
    "postID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CirclePostSignup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CirclePostSignup_postID_idx" ON "CirclePostSignup"("postID");

-- CreateIndex
CREATE INDEX "CirclePostSignup_userID_idx" ON "CirclePostSignup"("userID");

-- CreateIndex
CREATE UNIQUE INDEX "CirclePostSignup_postID_userID_key" ON "CirclePostSignup"("postID", "userID");

-- AddForeignKey
ALTER TABLE "CirclePostSignup" ADD CONSTRAINT "CirclePostSignup_postID_fkey" FOREIGN KEY ("postID") REFERENCES "CirclePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirclePostSignup" ADD CONSTRAINT "CirclePostSignup_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleActivity" ADD CONSTRAINT "CircleActivity_postID_fkey" FOREIGN KEY ("postID") REFERENCES "CirclePost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
