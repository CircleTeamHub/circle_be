CREATE TABLE "UserPrivacySetting" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "messageSelfDestructDays" INTEGER NOT NULL DEFAULT 2,
    "momentsVisibility" TEXT NOT NULL DEFAULT 'ALL',
    "allowStrangerMessages" BOOLEAN NOT NULL DEFAULT true,
    "showPhone" BOOLEAN NOT NULL DEFAULT false,
    "showWechat" BOOLEAN NOT NULL DEFAULT true,
    "showQQ" BOOLEAN NOT NULL DEFAULT true,
    "addMeByAccount" BOOLEAN NOT NULL DEFAULT true,
    "addMeByPhone" BOOLEAN NOT NULL DEFAULT false,
    "addMeByQrCode" BOOLEAN NOT NULL DEFAULT true,
    "addMeByGroup" BOOLEAN NOT NULL DEFAULT true,
    "callPermission" TEXT NOT NULL DEFAULT 'EVERYONE',
    "groupInvitePermission" TEXT NOT NULL DEFAULT 'EVERYONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPrivacySetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPrivacySetting_userID_key" ON "UserPrivacySetting"("userID");
CREATE INDEX "UserPrivacySetting_userID_idx" ON "UserPrivacySetting"("userID");

ALTER TABLE "UserPrivacySetting" ADD CONSTRAINT "UserPrivacySetting_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
