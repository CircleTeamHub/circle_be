-- 笔记打烊/下架提醒和圈子无关:开关从每条圈子订阅挪到用户级。
-- 默认开启,没有行就是开启,所以只为明确关掉的人建行。

-- CreateTable
CREATE TABLE "AssistantPreference" (
    "userID" TEXT NOT NULL,
    "assistantKey" TEXT NOT NULL DEFAULT 'windnote-assistant',
    "noteStatusAlerts" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantPreference_pkey" PRIMARY KEY ("userID","assistantKey")
);

-- AddForeignKey
ALTER TABLE "AssistantPreference" ADD CONSTRAINT "AssistantPreference_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 沿用旧答案:每条订阅上都选了「暂时不用」的人才算关掉。
INSERT INTO "AssistantPreference" ("userID", "assistantKey", "noteStatusAlerts", "updatedAt")
SELECT "userID", "assistantKey", false, CURRENT_TIMESTAMP
FROM "AssistantSubscription"
GROUP BY "userID", "assistantKey"
HAVING NOT bool_or("noteStatusAlerts");

-- AlterTable
ALTER TABLE "AssistantSubscription" DROP COLUMN "noteStatusAlerts";
