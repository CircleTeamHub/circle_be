-- 自研聊天（替代 OpenIM）：会话 / 成员 / 消息三表。
-- height 唯一约束 = 会话内消息序；clientMessageId 唯一约束 = 断线重发幂等。
BEGIN;

-- CreateEnum
CREATE TYPE "ChatConversationType" AS ENUM ('DIRECT', 'GROUP', 'TEMP', 'SUPPORT');

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "type" "ChatConversationType" NOT NULL,
    "directKey" TEXT,
    "circleID" TEXT,
    "tempChatID" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMember" (
    "id" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "lastReadHeight" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "hiddenAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "ChatMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "height" INTEGER NOT NULL,
    "senderID" TEXT,
    "type" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "clientMessageId" VARCHAR(128),
    "replyToID" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversation_directKey_key" ON "ChatConversation"("directKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversation_circleID_key" ON "ChatConversation"("circleID");

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversation_tempChatID_key" ON "ChatConversation"("tempChatID");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMember_conversationID_userID_key" ON "ChatMember"("conversationID", "userID");

-- CreateIndex
CREATE INDEX "ChatMember_userID_idx" ON "ChatMember"("userID");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_conversationID_height_key" ON "ChatMessage"("conversationID", "height");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_conversationID_senderID_clientMessageId_key" ON "ChatMessage"("conversationID", "senderID", "clientMessageId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationID_createdAt_idx" ON "ChatMessage"("conversationID", "createdAt");

-- AddForeignKey
ALTER TABLE "ChatMember" ADD CONSTRAINT "ChatMember_conversationID_fkey" FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationID_fkey" FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
