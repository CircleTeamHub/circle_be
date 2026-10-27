-- 笔记来源状态广播改走 outbox:收藏链根的反规范列 + outbox 表。
--
-- 这一批拆成几份,每份只在一张热表上拿表锁,回填和加列分开:
--   0000 Note 加列 + outbox 枚举与表(本份)
--   0010 ChatMessage 加列
--   0020 回填 Note."rootSourceNoteID"
--   0030 回填 ChatMessage."sourceNoteID"
--   0100 并发建两条查询索引
-- 加列要拿 ACCESS EXCLUSIVE,和回填放在一个事务里的话,这把锁会一直持有到回填扫完
-- 整张表,期间所有读写都排队。分开之后加列一提交就放锁,回填只拿行锁。
--
-- 可空加列、无默认值:只改目录,不重写表。等不到 5 秒就整份回滚,别把读写堵在锁队列
-- 里。失败时 _prisma_migrations 留下一条失败记录:先
-- `npx prisma migrate resolve --rolled-back 20261020000000_add_note_status_fanout_outbox`,
-- 避开长事务后重跑 migrate deploy。
SET lock_timeout = '5s';

-- 收藏链的稳定根。根笔记被硬删后仍保留 id,故意不建外键。
ALTER TABLE "Note" ADD COLUMN "rootSourceNoteID" TEXT;

CREATE TYPE "NoteStatusFanoutOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'FAILED');
CREATE TYPE "NoteStatusFanoutStage" AS ENUM ('OWNERS', 'CHAT_MEMBERS');

CREATE TABLE "NoteStatusFanoutOutbox" (
  "rootNoteID" TEXT NOT NULL,
  "status" "NoteStatusFanoutOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "stage" "NoteStatusFanoutStage" NOT NULL DEFAULT 'OWNERS',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "noteCursor" TEXT,
  "chatConversationCursor" TEXT,
  "chatUserCursor" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastError" VARCHAR(1000),
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NoteStatusFanoutOutbox_pkey" PRIMARY KEY ("rootNoteID")
);

CREATE INDEX "NoteStatusFanoutOutbox_status_nextAttemptAt_queuedAt_idx"
  ON "NoteStatusFanoutOutbox" ("status", "nextAttemptAt", "queuedAt");

RESET lock_timeout;
