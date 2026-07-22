-- round 2 review：两个高频扫表补索引。
-- 1) 礼物卡补偿 cron 每分钟查 cardDeliveredAt IS NULL 的待补行 —— 回填后
--    全表几乎全是已送达行，无索引等于每分钟顺序扫描。局部索引只覆盖待补行，
--    体积恒小。
CREATE INDEX "CoinGift_pending_card_idx"
  ON "CoinGift"("createdAt")
  WHERE "cardDeliveredAt" IS NULL;

-- 2) push 投递行按 outboxID+status(+attempts) 反复查询/计数；Postgres 不会
--    自动为外键建索引，表一大每次重试都全表扫。
CREATE INDEX "NotificationPushDelivery_outbox_status_idx"
  ON "NotificationPushDelivery"("outboxID", "status", "attempts");
