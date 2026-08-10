-- 撤回/焚毁的媒体物删待办表。
-- 消息 content 在撤回那一刻就清空了，object key 无法从业务数据重建：
-- 只在进程内存里重试的话，一次重启或一次超过重试次数的存储故障就把它永久丢了。
CREATE TABLE "ChatMediaDeletion" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMediaDeletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatMediaDeletion_objectKey_key" ON "ChatMediaDeletion"("objectKey");
CREATE INDEX "ChatMediaDeletion_nextAttemptAt_idx" ON "ChatMediaDeletion"("nextAttemptAt");
