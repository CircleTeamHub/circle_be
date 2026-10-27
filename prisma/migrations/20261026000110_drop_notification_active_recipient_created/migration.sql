-- 删掉 Notification_active_recipient_created_idx (toUserID, createdAt DESC, id DESC)
-- WHERE deleted = false。替换件 Notification_active_recipient_created_type_idx 见
-- 20261026000100:前三列与谓词完全相同,只在末尾多一个 type key 列,能用旧索引的
-- 查询(列表首页 / 老分页 / 游标续页 / 去重窗口)都能用新索引。
--
-- 一份迁移只放这一条:Prisma 只在文件里全是 CREATE INDEX CONCURRENTLY 时才逐条放到
-- 事务外执行,混进 DROP 或多条 DROP 就整份进事务,部署报 25001。
DROP INDEX CONCURRENTLY IF EXISTS "Notification_active_recipient_created_idx";
