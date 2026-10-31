-- 房主删除临时聊天 = 软删:行留着给每日创建配额计数,列表按 deletedAt IS NULL 过滤。
-- 可空加列、无默认值,只改目录。

-- AlterTable
ALTER TABLE "TempChat" ADD COLUMN "deletedAt" TIMESTAMP(3);
