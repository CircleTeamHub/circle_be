-- 私聊「申请双向清空」:新表,不碰已有数据。
CREATE TYPE "ChatClearRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

CREATE TABLE "ChatClearRequest" (
    "id" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "requesterID" TEXT NOT NULL,
    "targetHeight" INTEGER NOT NULL,
    "status" "ChatClearRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "ChatClearRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatClearRequest_conversationID_status_idx" ON "ChatClearRequest"("conversationID", "status");
