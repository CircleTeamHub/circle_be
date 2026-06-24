CREATE TYPE "IconAssetSourceType" AS ENUM ('SYSTEM', 'CIRCLE');
CREATE TYPE "UserDisplayIconType" AS ENUM ('SYSTEM', 'CIRCLE');
CREATE TYPE "SystemIconKey" AS ENUM ('VIP', 'NEW_USER');

ALTER TABLE "Circle"
ADD COLUMN "currentIconAssetID" TEXT;

CREATE TABLE "IconAsset" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sourceType" "IconAssetSourceType" NOT NULL,
  "imageUrl" TEXT,
  "circleID" TEXT,
  "createdByID" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IconAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserDisplayIcon" (
  "id" TEXT NOT NULL,
  "userID" TEXT NOT NULL,
  "displayType" "UserDisplayIconType" NOT NULL,
  "systemKey" "SystemIconKey",
  "circleID" TEXT,
  "sortOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserDisplayIcon_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserDisplayIcon_userID_systemKey_key"
ON "UserDisplayIcon"("userID", "systemKey");

CREATE UNIQUE INDEX "UserDisplayIcon_userID_circleID_key"
ON "UserDisplayIcon"("userID", "circleID");

CREATE INDEX "IconAsset_circleID_idx" ON "IconAsset"("circleID");
CREATE INDEX "IconAsset_sourceType_idx" ON "IconAsset"("sourceType");
CREATE INDEX "UserDisplayIcon_userID_sortOrder_idx"
ON "UserDisplayIcon"("userID", "sortOrder");

ALTER TABLE "Circle"
ADD CONSTRAINT "Circle_currentIconAssetID_fkey"
FOREIGN KEY ("currentIconAssetID") REFERENCES "IconAsset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IconAsset"
ADD CONSTRAINT "IconAsset_circleID_fkey"
FOREIGN KEY ("circleID") REFERENCES "Circle"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IconAsset"
ADD CONSTRAINT "IconAsset_createdByID_fkey"
FOREIGN KEY ("createdByID") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserDisplayIcon"
ADD CONSTRAINT "UserDisplayIcon_userID_fkey"
FOREIGN KEY ("userID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserDisplayIcon"
ADD CONSTRAINT "UserDisplayIcon_circleID_fkey"
FOREIGN KEY ("circleID") REFERENCES "Circle"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "IconAsset" ("id", "name", "sourceType", "imageUrl", "createdAt", "updatedAt")
VALUES
  ('sys-circle-star', '默认星标', 'SYSTEM', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('sys-circle-flame', '默认火焰', 'SYSTEM', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('sys-circle-crown', '默认皇冠', 'SYSTEM', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
