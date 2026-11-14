-- 笔记城市 + 大众点评月榜（GET /note/ranking）。
--
-- 加性迁移:两列都是可空、无默认值,只改目录,不回填 —— 老笔记没有城市,不进榜单;
-- 旧版本后端不读它们。Note 是热表:拿 ACCESS EXCLUSIVE 等不到 5 秒就失败,别排在长事务
-- 后面把笔记的读写一起堵住。失败时先
-- `npx prisma migrate resolve --rolled-back 20261113120000_note_city_ranking`,
-- 避开长事务后重跑 migrate deploy。
--
-- 榜单按 (month, goodCount) 取本月好评最多的笔记(note-ranking.query.ts)。NoteRatingMonthly
-- 是 20261111120000 才建的新表,行数很少,普通 CREATE INDEX 只短暂挡住评价计数的写入。
SET lock_timeout = '5s';

ALTER TABLE "Note" ADD COLUMN "city" VARCHAR(32);

ALTER TABLE "NoteDraft" ADD COLUMN "city" VARCHAR(32);

CREATE INDEX "NoteRatingMonthly_month_goodCount_idx" ON "NoteRatingMonthly"("month", "goodCount");

RESET lock_timeout;
