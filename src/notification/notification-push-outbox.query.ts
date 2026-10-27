import { Prisma } from 'src/generated/prisma';

/** 推送 outbox 每轮(每分钟)最多出队多少条。 */
export const PUSH_OUTBOX_BATCH_SIZE = 100;

/**
 * 一次 tick 里，同一个发送者最多占多少个投递名额。
 *
 * 为什么需要这个：出队是 PUSH_OUTBOX_BATCH_SIZE 条/分钟，而一次发圈帖扇出上限 500 人
 * （CIRCLE_POST_PUBLISH_FANOUT_CAP），发帖接口限流是 40 次/15 分钟/IP —— 单个账号
 * 就能以约 1300 条/分钟往队列里灌，比出队快 13 倍。队列按 createdAt 升序取，于是
 * 正常推送（好友请求、评论回复、系统通知）全部排在洪水后面：脚本跑十分钟就能买到
 * 约两小时的全站推送黑屏。
 *
 * 公平调度只改「先发谁」，不提高发送速率 —— 对推送服务商的压力一点没变，因此不存在
 * 被上游限流或封禁的风险。攻击者仍会占满自己的配额，但吃不掉别人的。
 */
export const MAX_PER_SENDER_PER_TICK = 10;

/**
 * 系统公告一轮的名额，独立于发送者配额。
 *
 * 公告扇出给每个活跃用户建一行，而这些行的 fromUserID 全是同一个管理员，落进
 * 发送者配额里就是「整条公告共用 10 条/轮」—— 10000 人的公告要发约 17 小时。
 * 但公告不是发送者洪水：每一行的收件人都不同，管理员也不是要防的那个角色，
 * 拿发送者配额去套它属于误伤。
 *
 * 所以公告改成**按公告 ID 分区**（同一管理员发的两条公告互不挤占），并给一份
 * 更宽的名额。上限仍然存在而不是完全豁免 —— 豁免的话一条大公告会吃满整批
 * PUSH_OUTBOX_BATCH_SIZE，把好友请求、评论回复挤到公告发完为止，等于把饿死方向调了个头。
 * 取 PUSH_OUTBOX_BATCH_SIZE 的一半：公告按 50 条/轮走，另外一半永远留给日常推送。
 */
export const SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK = PUSH_OUTBOX_BATCH_SIZE / 2;

export type PushOutboxFairBatchInput = {
  now: Date;
  /** lockedAt 早于它的 PROCESSING 行视为持有者已崩溃，可以重新领取。 */
  staleBefore: Date;
};

/**
 * 这一轮要出队的 outbox id，按名次排好序。口径（与改动前逐字等价）：
 *
 * - 可领取：PENDING / FAILED 且 nextAttemptAt <= now，或 PROCESSING 且锁已过期；
 * - 分区：公告行按公告 ID（`announcement:<id>`），其余按发送者（`sender:<fromUserID>`）；
 * - 分区内按 (createdAt, id) 排名，公告每个分区至多 SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK 条、
 *   发送者至多 MAX_PER_SENDER_PER_TICK 条；
 * - 全局按 (名次, createdAt, id) 取前 PUSH_OUTBOX_BATCH_SIZE —— 「每个人的第一条」一定先于
 *   「任何人的第二条」，新来的发送者立刻能挤进这一轮；
 * - 推送总开关（ConsolePushSettings.global.enabled）关着时一条不出。
 *
 * 名额分配必须跨**整个**待发队列做，不能先按 createdAt 取一个窗口再在窗口里调度：
 * 洪水本身就会把窗口占满（灌 13000 条之后再来一条正常推送，要等约 22 小时）。
 *
 * 改动前是「全积压 join Notification + ROW_NUMBER 窗口排序」：5 万人的公告要约 1000 轮
 * 才排空，每一轮都对 5 万行做 join 和排序，规模再大就逼近 15 秒语句超时，整个推送
 * cron 跟着停。现在的形状：
 *
 * 1. 分区键反规范到 outbox.fairnessKey（迁移 20261026000800 的 BEFORE INSERT 触发器
 *    按 Notification 填，口径就是上面那个 CASE；应用层不写这一列）；
 * 2. 递归 CTE 在部分索引 NotificationPushOutbox_fairness_queue_idx
 *    (fairnessKey, createdAt, id) WHERE 待发 上做 loose index scan，逐个跳到下一个
 *    有待发行的分区 —— 成本是「分区数」而不是「积压行数」；
 * 3. 每个分区 LATERAL 沿同一个索引按 (createdAt, id) 取前「配额」条可领取的行；
 * 4. 迁移前写入、fairnessKey 为 NULL 的老行走兜底分支：沿用 join 取分区键，由部分索引
 *    NotificationPushOutbox_legacy_queue_idx 只扫老行（排空后近乎为空）；
 * 5. 两路候选合并后再按分区排一次名、截配额、排序取批。
 *
 * 为什么结果与旧查询相同：每个分区的候选里包含了该分区「全部可领取行」中排在最前的
 * 配额条（新行取了各自的前配额条，老行全部在内），没进候选的新行前面至少已有配额条，
 * 真实名次必然超额。所以截配额之后的行集合和名次都与旧查询一致，最后的排序与 LIMIT
 * 也一样。test/postgres/notification-fanout-push-outbox.pg-spec.ts 在随机场景和逐轮排空
 * 的全过程里对照新旧两条查询。
 *
 * status 写成字面量而不是参数：部分索引的谓词要在规划期被证明。
 */
export function pushOutboxFairBatchQuery(
  input: PushOutboxFairBatchInput,
): Prisma.Sql {
  const eligible = Prisma.sql`(
    (o."status" = 'PENDING' AND o."nextAttemptAt" <= ${input.now})
    OR (o."status" = 'FAILED' AND o."nextAttemptAt" <= ${input.now})
    OR (o."status" = 'PROCESSING' AND o."lockedAt" < ${input.staleBefore})
  )`;
  // 两个分支都是绑定参数，不显式转型的话 Postgres 推不出 CASE 的结果类型
  // （两侧都是 unknown），会直接报 could not determine data type。
  const quota = (key: Prisma.Sql) => Prisma.sql`CASE
    WHEN ${key} LIKE 'announcement:%' THEN ${SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK}::int
    ELSE ${MAX_PER_SENDER_PER_TICK}::int
  END`;
  return Prisma.sql`
    WITH RECURSIVE partitions AS (
      (
        SELECT o."fairnessKey" AS key
        FROM "NotificationPushOutbox" AS o
        WHERE o."fairnessKey" IS NOT NULL
          AND o."status" IN ('PENDING', 'FAILED', 'PROCESSING')
        ORDER BY o."fairnessKey"
        LIMIT 1
      )
      UNION ALL
      SELECT (
        SELECT o."fairnessKey"
        FROM "NotificationPushOutbox" AS o
        WHERE o."fairnessKey" > p.key
          AND o."status" IN ('PENDING', 'FAILED', 'PROCESSING')
        ORDER BY o."fairnessKey"
        LIMIT 1
      )
      FROM partitions AS p
      WHERE p.key IS NOT NULL
    ),
    candidates AS (
      SELECT c."id", c."createdAt", p.key
      FROM partitions AS p
      CROSS JOIN LATERAL (
        SELECT o."id", o."createdAt"
        FROM "NotificationPushOutbox" AS o
        WHERE o."fairnessKey" = p.key
          AND o."status" IN ('PENDING', 'FAILED', 'PROCESSING')
          AND ${eligible}
        ORDER BY o."createdAt" ASC, o."id" ASC
        LIMIT ${quota(Prisma.sql`p.key`)}
      ) AS c
      WHERE p.key IS NOT NULL
      UNION ALL
      SELECT
        o."id",
        o."createdAt",
        CASE
          WHEN n."systemAnnouncementID" IS NOT NULL
            THEN 'announcement:' || n."systemAnnouncementID"
          ELSE 'sender:' || n."fromUserID"
        END AS key
      FROM "NotificationPushOutbox" AS o
      JOIN "Notification" AS n ON n."id" = o."notificationID"
      WHERE o."fairnessKey" IS NULL
        AND o."status" IN ('PENDING', 'FAILED', 'PROCESSING')
        AND ${eligible}
    ),
    ranked AS (
      SELECT
        "id",
        "createdAt",
        key,
        ROW_NUMBER() OVER (
          PARTITION BY key
          ORDER BY "createdAt" ASC, "id" ASC
        ) AS rn
      FROM candidates
    )
    SELECT "id"
    FROM ranked
    WHERE EXISTS (
        SELECT 1 FROM "ConsolePushSettings" WHERE id = 'global' AND enabled
      )
      AND rn <= ${quota(Prisma.sql`key`)}
    ORDER BY rn ASC, "createdAt" ASC, "id" ASC
    LIMIT ${PUSH_OUTBOX_BATCH_SIZE}
  `;
}
