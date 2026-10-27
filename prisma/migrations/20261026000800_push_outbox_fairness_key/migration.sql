-- 推送 outbox 出队的公平分区键(src/notification/notification-push-outbox.query.ts)。
--
-- 出队要按「公告 ID / 发送者」分区限额,分区信息在 Notification 上,于是每一轮都得把
-- 整个待发积压 join 一遍再做窗口排序 —— 5 万人的公告要约 1000 轮才排空,每轮都是
-- 5 万行 join + 排序。把分区键反规范到 outbox 上,配合 20261026000810 的部分索引,
-- 出队就能按分区逐个跳着取,不再碰全量积压。
--
-- 可空加列,无默认值:只改目录,不重写表。存量行不回填(热表上不做大回填)——
-- fairnessKey 为 NULL 的老行由出队查询的兜底分支沿用 join 处理,排空后自然消失。
--
-- 值由 BEFORE INSERT 触发器按 Notification 计算,口径与旧查询 PARTITION BY 的 CASE
-- 一字不差;应用层不写这一列(写了也会被覆盖),所以任何写 outbox 的路径都不会漏填。
-- Notification 的 fromUserID / systemAnnouncementID 建成后从不更新,键不会过期。
--
-- 有函数体:整份迁移放在一个事务里执行,不能和 CONCURRENTLY 放在一起。
--
-- 加列和建触发器都要拿 ACCESS EXCLUSIVE 锁,而这张表每条通知都要写:撞上长查询时,
-- 后面所有写 outbox 的事务都会排在 ALTER 后面。等不到 5 秒就整份回滚,别把写入堵在
-- 锁队列里。失败时 _prisma_migrations 留下一条失败记录:先
-- `npx prisma migrate resolve --rolled-back 20261026000800_push_outbox_fairness_key`,
-- 避开长查询后重跑 migrate deploy。
SET lock_timeout = '5s';

ALTER TABLE "NotificationPushOutbox" ADD COLUMN "fairnessKey" TEXT;

CREATE OR REPLACE FUNCTION circle_push_outbox_fairness_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT CASE
           WHEN n."systemAnnouncementID" IS NOT NULL
             THEN 'announcement:' || n."systemAnnouncementID"
           ELSE 'sender:' || n."fromUserID"
         END
    INTO NEW."fairnessKey"
    FROM "Notification" AS n
   WHERE n."id" = NEW."notificationID";
  RETURN NEW;
END $$;

CREATE TRIGGER push_outbox_fairness_key
BEFORE INSERT ON "NotificationPushOutbox"
FOR EACH ROW EXECUTE FUNCTION circle_push_outbox_fairness_key();

RESET lock_timeout;
