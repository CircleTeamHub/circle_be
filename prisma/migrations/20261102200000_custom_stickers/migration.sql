CREATE TABLE "CustomSticker" (
  "id" TEXT NOT NULL,
  "userID" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "sourceMessageID" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomSticker_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomSticker_userID_objectKey_key" ON "CustomSticker"("userID", "objectKey");
CREATE UNIQUE INDEX "CustomSticker_userID_sourceMessageID_key" ON "CustomSticker"("userID", "sourceMessageID");
CREATE INDEX "CustomSticker_userID_createdAt_id_idx" ON "CustomSticker"("userID", "createdAt", "id");
ALTER TABLE "CustomSticker" ADD CONSTRAINT "CustomSticker_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
