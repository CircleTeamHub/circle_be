-- AlterTable
ALTER TABLE "User" ADD COLUMN     "receivedLikeCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "UserLike" (
    "id" TEXT NOT NULL,
    "fromUserID" TEXT NOT NULL,
    "toUserID" TEXT NOT NULL,
    "likedOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserLike_toUserID_idx" ON "UserLike"("toUserID");

-- CreateIndex
CREATE INDEX "UserLike_fromUserID_idx" ON "UserLike"("fromUserID");

-- CreateIndex
CREATE UNIQUE INDEX "UserLike_fromUserID_toUserID_likedOn_key" ON "UserLike"("fromUserID", "toUserID", "likedOn");

-- AddForeignKey
ALTER TABLE "UserLike" ADD CONSTRAINT "UserLike_fromUserID_fkey" FOREIGN KEY ("fromUserID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLike" ADD CONSTRAINT "UserLike_toUserID_fkey" FOREIGN KEY ("toUserID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

