import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_PER_SENDER_PER_TICK,
  PUSH_OUTBOX_BATCH_SIZE,
  pushOutboxFairBatchQuery,
  SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK,
} from 'src/notification/notification-push-outbox.query';
import {
  describePostgres,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 推送 outbox 出队排名(迁移 20261026000800 / 0810)在真 PostgreSQL 16 上:
 * - 触发器按 Notification 填 fairnessKey,口径就是旧查询 PARTITION BY 的那个 CASE;
 * - 新查询(按分区键 LATERAL 各取前 N 条 + 老行兜底)与旧查询(全积压 join + 窗口排序)
 *   在随机场景和逐轮排空的全过程里选出完全相同的行、相同的顺序;
 * - 5 万行公告积压下,新查询的计划里没有任何节点碰到全量积压,旧查询有。
 */
const KEY_MIGRATION = '20261026000800_push_outbox_fairness_key';
const INDEX_MIGRATION = '20261026000810_push_outbox_fairness_queue_indexes';

/** 改动前 processor 里的出队查询原文(参照答案;$1 = now,$2 = staleBefore)。 */
const LEGACY_FAIR_BATCH_SQL = `
  WITH eligible AS (
    SELECT
      o."id",
      o."createdAt",
      (n."systemAnnouncementID" IS NOT NULL) AS is_announcement,
      ROW_NUMBER() OVER (
        PARTITION BY CASE
          WHEN n."systemAnnouncementID" IS NOT NULL
            THEN 'announcement:' || n."systemAnnouncementID"
          ELSE 'sender:' || n."fromUserID"
        END
        ORDER BY o."createdAt" ASC, o."id" ASC
      ) AS rn
    FROM "NotificationPushOutbox" AS o
    JOIN "Notification" AS n ON n."id" = o."notificationID"
    WHERE EXISTS (SELECT 1 FROM "ConsolePushSettings" WHERE id='global' AND enabled)
      AND ((o."status" = 'PENDING' AND o."nextAttemptAt" <= $1)
       OR (o."status" = 'FAILED' AND o."nextAttemptAt" <= $1)
       OR (o."status" = 'PROCESSING' AND o."lockedAt" < $2))
  )
  SELECT "id"
  FROM eligible
  WHERE rn <= CASE
    WHEN is_announcement THEN ${SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK}::int
    ELSE ${MAX_PER_SENDER_PER_TICK}::int
  END
  ORDER BY rn ASC, "createdAt" ASC, "id" ASC
  LIMIT ${PUSH_OUTBOX_BATCH_SIZE}
`;

const STALE_LOCK_MS = 10 * 60 * 1000;
const T0 = Date.parse('2026-10-26T00:00:00.000Z');

type Status = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'TERMINAL';
type Row = {
  id: string;
  sender: string;
  announcement: string | null;
  status: Status;
  createdAt: Date;
  nextAttemptAt: Date;
  lockedAt: Date | null;
  legacy: boolean;
};

/** 状态分布:多数待发,其余失败退避 / 处理中 / 已完成 / 终态。 */
const STATUS_THRESHOLDS: ReadonlyArray<[number, Status]> = [
  [0.55, 'PENDING'],
  [0.7, 'FAILED'],
  [0.8, 'PROCESSING'],
  [0.92, 'COMPLETED'],
  [1, 'TERMINAL'],
];
const pickStatus = (roll: number): Status =>
  STATUS_THRESHOLDS.find(([limit]) => roll < limit)?.[1] ?? 'TERMINAL';

/** 可复现的伪随机数(mulberry32),失败时用同一个种子能重放。 */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PlanNode = {
  'Node Type': string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Index Name'?: string;
  Plans?: PlanNode[];
};

const walk = (node: PlanNode, visit: (node: PlanNode) => void) => {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
};

/** 一个节点总共摸过多少行:吐出的 + 被过滤掉的,乘以执行次数。 */
const touched = (node: PlanNode) =>
  ((node['Actual Rows'] ?? 0) +
    (node['Rows Removed by Filter'] ?? 0) +
    (node['Rows Removed by Index Recheck'] ?? 0)) *
  (node['Actual Loops'] ?? 1);

/** 排序 / 窗口节点的输入行数(子节点吐出的总行数)。 */
const sortInputs = (root: PlanNode) => {
  const inputs: number[] = [];
  walk(root, (node) => {
    if (!/Sort|WindowAgg/.test(node['Node Type'])) return;
    inputs.push(
      (node.Plans ?? []).reduce(
        (sum, child) =>
          sum + (child['Actual Rows'] ?? 0) * (child['Actual Loops'] ?? 1),
        0,
      ),
    );
  });
  return inputs;
};

describePostgres('notification push outbox fair batch (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const migrationSql = (name: string) =>
    readFileSync(
      join(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
      'utf8',
    );

  const reset = async () => {
    await s.db.query(
      'TRUNCATE "NotificationPushOutbox", "Notification" CASCADE',
    );
  };

  const insertRows = async (rows: readonly Row[]) => {
    for (let i = 0; i < rows.length; i += 5000) {
      const chunk = rows.slice(i, i + 5000);
      await s.db.query(
        `INSERT INTO "Notification" (id, "fromUserID", "toUserID", "systemAnnouncementID")
         SELECT 'n-' || id, sender, 'to-' || id, ann
         FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, sender, ann)`,
        [
          chunk.map((row) => row.id),
          chunk.map((row) => row.sender),
          chunk.map((row) => row.announcement),
        ],
      );
      await s.db.query(
        `INSERT INTO "NotificationPushOutbox"
           (id, "notificationID", status, "createdAt", "nextAttemptAt", "lockedAt")
         SELECT id, 'n-' || id, status::"NotificationPushOutboxStatus",
                created, next_at, locked
         FROM unnest($1::text[], $2::text[], $3::timestamp[], $4::timestamp[], $5::timestamp[])
           AS t(id, status, created, next_at, locked)`,
        [
          chunk.map((row) => row.id),
          chunk.map((row) => row.status),
          chunk.map((row) => row.createdAt),
          chunk.map((row) => row.nextAttemptAt),
          chunk.map((row) => row.lockedAt),
        ],
      );
      const legacy = chunk.filter((row) => row.legacy).map((row) => row.id);
      if (legacy.length > 0) {
        // 迁移前写入的老行没有 fairnessKey(触发器只管新写入)。
        await s.db.query(
          `UPDATE "NotificationPushOutbox" SET "fairnessKey" = NULL WHERE id = ANY($1::text[])`,
          [legacy],
        );
      }
    }
    await s.db.query('ANALYZE "NotificationPushOutbox"');
    await s.db.query('ANALYZE "Notification"');
  };

  const legacyBatch = async (now: Date) => {
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const { rows } = await s.db.query<{ id: string }>(LEGACY_FAIR_BATCH_SQL, [
      now,
      staleBefore,
    ]);
    return rows.map((row) => row.id);
  };

  const newQuery = (now: Date) =>
    pushOutboxFairBatchQuery({
      now,
      staleBefore: new Date(now.getTime() - STALE_LOCK_MS),
    });

  const newBatch = async (now: Date) => {
    const q = newQuery(now);
    const { rows } = await s.db.query<{ id: string }>(q.text, q.values);
    return rows.map((row) => row.id);
  };

  const explainAnalyze = async (sql: string, values: unknown[]) => {
    const { rows } = await s.db.query<{
      'QUERY PLAN': Array<{ Plan: PlanNode }>;
    }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
    return rows[0]['QUERY PLAN'][0].Plan;
  };

  /**
   * 随机场景:若干公告、若干洪水发送者、一批零散发送者,状态与时间全打散。
   * - users:零散发送者的个数。分区少的时候整批填不满第二名,配额才真正起作用;
   * - timeBuckets:createdAt 只取这么多个不同的秒,桶越少平局越多,用来验证
   *   (createdAt, id) 的平局次序在配额边界上也一致。
   */
  type Scenario = {
    seed: number;
    size: number;
    legacyShare: number;
    users: number;
    timeBuckets: number;
  };
  const randomRows = ({
    seed,
    size,
    legacyShare,
    users,
    timeBuckets,
  }: Scenario) => {
    const rand = prng(seed);
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(rand() * items.length)];
    const announcements = ['ann-a', 'ann-b', 'ann-c'];
    const floods = ['flood-1', 'flood-2'];
    const rows: Row[] = [];
    for (let i = 0; i < size; i += 1) {
      const kind = rand();
      let announcement: string | null = null;
      if (kind < 0.4) announcement = pick(announcements);
      else if (kind < 0.45) announcement = 'ann-tiny';
      let sender = `user-${Math.floor(rand() * users)}`;
      if (announcement) sender = `recipient-${i}`;
      else if (kind < 0.75) sender = pick(floods);
      const status = pickStatus(rand());
      const createdAt = new Date(T0 + Math.floor(rand() * timeBuckets) * 1000);
      rows.push({
        id: `o-${String(i).padStart(6, '0')}-${Math.floor(rand() * 1e6)}`,
        sender,
        announcement,
        status,
        createdAt,
        nextAttemptAt: new Date(T0 + (rand() - 0.3) * size * 2000),
        lockedAt:
          status === 'PROCESSING'
            ? new Date(T0 + (rand() - 0.5) * size * 4000)
            : null,
        legacy: rand() < legacyShare,
      });
    }
    return rows;
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('push_fair');
    await s.db.query(`
      CREATE TYPE "NotificationPushOutboxStatus" AS ENUM
        ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'TERMINAL');
      CREATE TABLE "ConsolePushSettings" (id text PRIMARY KEY, enabled boolean NOT NULL);
      INSERT INTO "ConsolePushSettings" VALUES ('global', true);
      CREATE TABLE "Notification" (
        id text PRIMARY KEY,
        "fromUserID" text NOT NULL,
        "toUserID" text,
        "systemAnnouncementID" text
      );
      CREATE TABLE "NotificationPushOutbox" (
        id text PRIMARY KEY,
        "notificationID" text NOT NULL REFERENCES "Notification"(id) ON DELETE CASCADE,
        status "NotificationPushOutboxStatus" NOT NULL DEFAULT 'PENDING',
        "leaseToken" text,
        attempts integer NOT NULL DEFAULT 0,
        "nextAttemptAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lockedAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX "NotificationPushOutbox_notificationID_key"
        ON "NotificationPushOutbox" ("notificationID");
      CREATE INDEX "NotificationPushOutbox_status_nextAttemptAt_idx"
        ON "NotificationPushOutbox" (status, "nextAttemptAt");
      CREATE INDEX "NotificationPushOutbox_createdAt_id_idx"
        ON "NotificationPushOutbox" ("createdAt" DESC, id DESC);
    `);
    // 加列 + 触发器函数:有函数体,整份一个事务执行(Prisma 对这类文件也是这样)。
    await s.db.query(migrationSql(KEY_MIGRATION));
    // CREATE INDEX CONCURRENTLY 不能放进多语句的隐式事务,逐条执行。
    const statements = migrationSql(INDEX_MIGRATION)
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) await s.db.query(statement);
  });

  afterAll(async () => {
    await s?.close();
  });

  it('fills the fairness key on insert exactly like the old PARTITION BY expression', async () => {
    await reset();
    await s.db.query(`
      INSERT INTO "Notification" (id, "fromUserID", "toUserID", "systemAnnouncementID") VALUES
        ('n-ann', 'recipient-1', 'recipient-1', 'ann-1'),
        ('n-sender', 'alice', 'bob', NULL);
      -- 应用层永远不写这一列;就算写了也以 Notification 为准。
      INSERT INTO "NotificationPushOutbox" (id, "notificationID", "fairnessKey") VALUES
        ('o-ann', 'n-ann', NULL),
        ('o-sender', 'n-sender', 'sender:forged');
    `);
    const { rows } = await s.db.query<{ id: string; fairnessKey: string }>(
      `SELECT id, "fairnessKey" FROM "NotificationPushOutbox" ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'o-ann', fairnessKey: 'announcement:ann-1' },
      { id: 'o-sender', fairnessKey: 'sender:alice' },
    ]);
  });

  it.each<[string, Scenario]>([
    [
      'all legacy rows (no fairness key yet)',
      { seed: 11, size: 4000, legacyShare: 1, users: 60, timeBuckets: 2800 },
    ],
    [
      'all keyed rows',
      { seed: 12, size: 4000, legacyShare: 0, users: 60, timeBuckets: 2800 },
    ],
    [
      'a mix of legacy and keyed rows',
      { seed: 13, size: 4000, legacyShare: 0.3, users: 60, timeBuckets: 2800 },
    ],
    [
      'few partitions, so every quota binds',
      { seed: 14, size: 4000, legacyShare: 0.2, users: 3, timeBuckets: 2800 },
    ],
    [
      'heavy createdAt ties at the quota boundary',
      { seed: 15, size: 4000, legacyShare: 0.2, users: 3, timeBuckets: 6 },
    ],
  ])(
    'selects the same rows in the same order as the old query: %s',
    async (_label, scenario) => {
      await reset();
      await insertRows(randomRows(scenario));
      for (let probe = -2; probe <= 6; probe += 1) {
        const now = new Date(T0 + probe * 900_000);
        const expected = await legacyBatch(now);
        expect(expected.length).toBeGreaterThan(0);
        expect(await newBatch(now)).toEqual(expected);
      }
    },
  );

  it('stays identical to the old query through a whole drain, tick by tick', async () => {
    await reset();
    const rows = randomRows({
      seed: 21,
      size: 3000,
      legacyShare: 0.25,
      users: 4,
      timeBuckets: 400,
    });
    await insertRows(rows);
    let now = new Date(T0 + 3_600_000);
    let ticks = 0;
    for (; ticks < 400; ticks += 1) {
      const expected = await legacyBatch(now);
      expect(await newBatch(now)).toEqual(expected);
      if (expected.length === 0) break;
      // 模拟这一轮的结果:多数完成,一部分失败退避,少量卡在 PROCESSING(进程崩溃,
      // 10 分钟后过期重新可领)。每行至多重试两次,保证能排空。
      await s.db.query(
        `WITH outcome AS (
           SELECT o.id,
                  CASE WHEN o.attempts >= 2 THEN 'COMPLETED'
                       WHEN t.ord % 3 = 0 THEN 'FAILED'
                       WHEN t.ord % 7 = 1 THEN 'PROCESSING'
                       ELSE 'COMPLETED' END AS next_status
           FROM unnest($1::text[]) WITH ORDINALITY AS t(id, ord)
           JOIN "NotificationPushOutbox" AS o ON o.id = t.id
         )
         UPDATE "NotificationPushOutbox" AS o
         SET status = outcome.next_status::"NotificationPushOutboxStatus",
             attempts = o.attempts + 1,
             "lockedAt" = CASE WHEN outcome.next_status = 'PROCESSING' THEN $2::timestamp END,
             "nextAttemptAt" = CASE WHEN outcome.next_status = 'FAILED'
               THEN $2::timestamp + make_interval(secs => power(2, o.attempts + 1))
               ELSE o."nextAttemptAt" END
         FROM outcome WHERE o.id = outcome.id`,
        [expected, now],
      );
      now = new Date(now.getTime() + 60_000);
    }
    expect(ticks).toBeGreaterThan(20);
    expect(ticks).toBeLessThan(400);
  });

  it('returns nothing when push is globally disabled, like the old query', async () => {
    await reset();
    await insertRows(
      randomRows({
        seed: 31,
        size: 500,
        legacyShare: 0.5,
        users: 10,
        timeBuckets: 400,
      }),
    );
    await s.db.query(`UPDATE "ConsolePushSettings" SET enabled = false`);
    try {
      const now = new Date(T0 + 3_600_000);
      expect(await legacyBatch(now)).toEqual([]);
      expect(await newBatch(now)).toEqual([]);
    } finally {
      await s.db.query(`UPDATE "ConsolePushSettings" SET enabled = true`);
    }
  });

  describe('with a 50k-row announcement backlog', () => {
    const now = new Date(T0 + 86_400_000);

    beforeAll(async () => {
      await reset();
      const rows: Row[] = [];
      const base = {
        status: 'PENDING' as const,
        nextAttemptAt: new Date(T0),
        lockedAt: null,
        legacy: false,
      };
      for (let i = 0; i < 50_000; i += 1) {
        rows.push({
          ...base,
          id: `ann-${String(i).padStart(6, '0')}`,
          sender: `recipient-${i}`,
          announcement: 'ann-big',
          createdAt: new Date(T0 + i * 10),
        });
      }
      for (let i = 0; i < 5_000; i += 1) {
        rows.push({
          ...base,
          id: `flood-${String(i).padStart(6, '0')}`,
          sender: 'flooder',
          announcement: null,
          createdAt: new Date(T0 + 1000 + i * 10),
        });
      }
      for (const sender of ['s1', 's2', 's3']) {
        for (let i = 0; i < 2; i += 1) {
          rows.push({
            ...base,
            id: `${sender}-${i}`,
            sender,
            announcement: null,
            createdAt: new Date(T0 + 400_000 + i),
          });
        }
      }
      // 已处理完的历史行:不在待发索引里,但旧查询照样要 join 判断。
      for (let i = 0; i < 20_000; i += 1) {
        rows.push({
          ...base,
          status: 'COMPLETED',
          id: `done-${String(i).padStart(6, '0')}`,
          sender: `old-${i % 500}`,
          announcement: null,
          createdAt: new Date(T0 - 86_400_000 + i),
        });
      }
      await insertRows(rows);
      await s.db.query('VACUUM ANALYZE "NotificationPushOutbox"');
    });

    it('honours the per-announcement and per-sender quotas and the rank order', async () => {
      const ids = await newBatch(now);
      expect(ids).toEqual(await legacyBatch(now));

      const announcementRows = ids.filter((id) => id.startsWith('ann-'));
      const floodRows = ids.filter((id) => id.startsWith('flood-'));
      expect(announcementRows).toHaveLength(SYSTEM_ANNOUNCEMENT_ROWS_PER_TICK);
      expect(floodRows).toHaveLength(MAX_PER_SENDER_PER_TICK);
      for (const sender of ['s1', 's2', 's3']) {
        expect(ids.filter((id) => id.startsWith(`${sender}-`))).toEqual([
          `${sender}-0`,
          `${sender}-1`,
        ]);
      }
      // 每个分区的第一条都排在任何分区的第二条之前:新来的小发送者挤得进第一梯队。
      expect(new Set(ids.slice(0, 5))).toEqual(
        new Set(['ann-000000', 'flood-000000', 's1-0', 's2-0', 's3-0']),
      );
      expect(ids.length).toBeLessThan(PUSH_OUTBOX_BATCH_SIZE);
    });

    it('never touches the whole backlog, unlike the old join + window sort', async () => {
      const q = newQuery(now);
      const plan = await explainAnalyze(q.text, q.values);
      const legacyPlan = await explainAnalyze(LEGACY_FAIR_BATCH_SQL, [
        now,
        new Date(now.getTime() - STALE_LOCK_MS),
      ]);

      let newMax = 0;
      walk(plan, (node) => {
        newMax = Math.max(newMax, touched(node));
      });
      let legacyMax = 0;
      walk(legacyPlan, (node) => {
        legacyMax = Math.max(legacyMax, touched(node));
      });

      // 旧查询:窗口排序的输入就是 5.5 万行待发积压。
      expect(Math.max(...sortInputs(legacyPlan))).toBeGreaterThanOrEqual(
        55_000,
      );
      expect(legacyMax).toBeGreaterThanOrEqual(55_000);
      // 新查询:排序只吃候选(每个分区至多一个名额的行数),没有节点碰到积压量级。
      expect(Math.max(0, ...sortInputs(plan))).toBeLessThan(1_000);
      expect(newMax).toBeLessThan(1_000);
      const indexes = new Set<string>();
      walk(plan, (node) => {
        if (node['Index Name']) indexes.add(node['Index Name']);
      });
      expect(indexes).toContain('NotificationPushOutbox_fairness_queue_idx');
      expect(indexes).toContain('NotificationPushOutbox_legacy_queue_idx');
    });
  });
});
