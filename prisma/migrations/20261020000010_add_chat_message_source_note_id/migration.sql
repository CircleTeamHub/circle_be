-- 笔记卡片的根来源 id 落成列,广播找卡片所在会话不用再扫 JSON(背景见 20261020000000)。
--
-- ChatMessage 是全库最热的表:单独一份,只在这一张表上拿 ACCESS EXCLUSIVE;可空加列、
-- 无默认值,只改目录。回填在 20261020000030,不在这把锁里做。
--
-- 等不到 5 秒就整份回滚。失败时先
-- `npx prisma migrate resolve --rolled-back 20261020000010_add_chat_message_source_note_id`,
-- 避开长事务后重跑 migrate deploy。
SET lock_timeout = '5s';

ALTER TABLE "ChatMessage" ADD COLUMN "sourceNoteID" TEXT;

RESET lock_timeout;
