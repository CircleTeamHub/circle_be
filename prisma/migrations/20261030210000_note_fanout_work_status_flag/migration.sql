-- 收藏者的助手提醒只在开工/打烊真的切换时发:扇出任务带上这个标记。
-- 常量默认值,PG 11+ 只改目录不重写表。

-- AlterTable
ALTER TABLE "NoteStatusFanoutOutbox" ADD COLUMN "workStatusChanged" BOOLEAN NOT NULL DEFAULT false;
