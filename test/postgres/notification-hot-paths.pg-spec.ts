import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationType } from 'src/generated/prisma';
import {
  CIRCLE_NOTIFICATION_TYPES,
  DISCOVER_NOTIFICATION_TYPES,
  MOMENT_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from 'src/notification/notification.constants';
import { notificationPageScanQuery } from 'src/notification/notification-list.query';
import {
  sumUnreadNotificationsByDomain,
  unreadNotificationCountsByTypeQuery,
  type UnreadNotificationCountRow,
} from 'src/notification/notification-unread.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 通知热路径在真 PostgreSQL 16 上的口径与计划:
 * - 20261026000100 ~ 0130:列表索引带上 type、两个稀疏外键索引改成部分索引,旧索引删掉;
 * - 列表 id 扫描(notificationPageScanQuery)三种分页的结果与走的索引;
 * - 未读数的一条 GROUP BY(unreadNotificationCountsByTypeQuery)按域求和之后,与原来
 *   每个域一条 `count(*) ... type IN (...)` 逐项相等。
 *
 * 下面几条 *_SQL 是 Prisma 7 对应调用编译出来的语句形状(去掉 schema 前缀,离线编译
 * 核对过),调用方不在本次改动范围内,只用来证明部分索引对它们仍然可用。
 */
const MIGRATIONS = [
  '20261026000100_notification_recipient_type_and_sparse_fk_indexes',
  '20261026000110_drop_notification_active_recipient_created',
  '20261026000120_drop_notification_from_friend_request_idx',
  '20261026000130_drop_notification_from_group_admission_idx',
];

/** group-admission.service seen():入群审批详情页标已读。 */
const GROUP_ADMISSION_SEEN_SQL = `SELECT "Notification"."id" FROM "Notification"
  WHERE ("Notification"."toUserID" = $1 AND "Notification"."fromGroupAdmissionID" = $2
    AND "Notification"."read" = $3 AND "Notification"."deleted" = $4) OFFSET $5`;

/** group-admission.service 列表页:每条审批的未读数。 */
const GROUP_ADMISSION_UNREAD_SQL = `SELECT COUNT(*) AS "_count$_all", "Notification"."fromGroupAdmissionID"
  FROM "Notification"
  WHERE ("Notification"."toUserID" = $1 AND "Notification"."type" = CAST($2::text AS "NotificationType")
    AND "Notification"."read" = $3 AND "Notification"."deleted" = $4
    AND "Notification"."fromGroupAdmissionID" IN ($5,$6))
  GROUP BY "Notification"."fromGroupAdmissionID" OFFSET $7`;

/** chat.service 退群:把这个群的入群审批通知标已读(与 GroupAdmission 半连接)。 */
const GROUP_LEAVE_SQL = `UPDATE "Notification" SET "read" = $1
  WHERE ("Notification"."toUserID" = $2 AND "Notification"."read" = $3
    AND EXISTS(SELECT "t0"."id" FROM "GroupAdmission" AS "t0"
      WHERE ("t0"."conversationID" = $4 AND ("Notification"."fromGroupAdmissionID") = ("t0"."id")
        AND "t0"."id" IS NOT NULL)))`;

/** Friend 删除时外键 ON DELETE SET NULL 执行的等值更新。 */
const FRIEND_SET_NULL_SQL = `UPDATE ONLY "Notification" SET "fromFriendRequestID" = NULL
  WHERE $1 OPERATOR(pg_catalog.=) "fromFriendRequestID"`;

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

const ALL_TYPES = Object.values(NotificationType);
/** 大号 big 的类型分布:SYSTEM 极少,朋友圈互动占大头。 */
const BIG_TYPE_CYCLE = [
  'TRACE_LIKE',
  'TRACE_COMMENT',
  'CIRCLE_POST_PUBLISHED',
  'TRACE_LIKE',
  'FRIEND_REQUEST_RECEIVED',
  'CIRCLE_POST_SIGNUP_CREATED',
  'PROFILE_LIKE',
  'GROUP_ADMISSION',
];
const quoted = (values: readonly string[]) =>
  values.map((value) => "'" + value + "'").join(', ');
const BIG_TYPE_ARRAY = `ARRAY[${quoted(BIG_TYPE_CYCLE)}]`;

describePostgres('notification hot paths (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const indexNames = async () => {
    const { rows } = await s.db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'Notification'`,
      [s.schema],
    );
    return rows.map((row) => row.indexname).sort((a, b) => a.localeCompare(b));
  };

  const scan = async (
    input: Parameters<typeof notificationPageScanQuery>[0],
  ) => {
    const q = notificationPageScanQuery(input);
    const { rows } = await s.db.query<{ id: string; createdAt: Date }>(
      q.text,
      q.values,
    );
    return rows;
  };

  /** 参照答案:同样的条件,不经索引设计地直接排序取页。 */
  const reference = async (
    userId: string,
    types: readonly string[],
    limit: number,
    offset = 0,
  ) => {
    const { rows } = await s.db.query<{ id: string }>(
      `SELECT id FROM "Notification"
       WHERE "toUserID" = $1 AND deleted = false AND type::text = ANY($2::text[])
       ORDER BY "createdAt" DESC, id DESC LIMIT $3 OFFSET $4`,
      [userId, types, limit, offset],
    );
    return rows.map((row) => row.id);
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('notif_hot');
    await s.db.query(`
      CREATE TYPE "NotificationType" AS ENUM (${quoted(ALL_TYPES)});
      CREATE TABLE "Friend" (id text PRIMARY KEY);
      CREATE TABLE "GroupAdmission" (id text PRIMARY KEY, "conversationID" text NOT NULL);
      CREATE INDEX "GroupAdmission_conversationID_idx" ON "GroupAdmission" ("conversationID");
      CREATE TABLE "Notification" (
        id text PRIMARY KEY,
        content text NOT NULL DEFAULT '',
        deleted boolean NOT NULL DEFAULT false,
        read boolean NOT NULL DEFAULT false,
        type "NotificationType" NOT NULL,
        "toUserID" text,
        "fromUserID" text NOT NULL,
        "fromFriendRequestID" text REFERENCES "Friend"(id) ON DELETE SET NULL,
        "fromGroupAdmissionID" text REFERENCES "GroupAdmission"(id),
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "Notification_fromUserID_toUserID_idx" ON "Notification" ("fromUserID", "toUserID");
      CREATE INDEX "Notification_toUserID_idx" ON "Notification" ("toUserID");
      CREATE INDEX "Notification_createdAt_idx" ON "Notification" ("createdAt");
      CREATE INDEX "Notification_fromFriendRequestID_idx" ON "Notification" ("fromFriendRequestID");
      CREATE INDEX "Notification_fromGroupAdmissionID_idx" ON "Notification" ("fromGroupAdmissionID");
      CREATE INDEX "Notification_active_recipient_created_idx"
        ON "Notification" ("toUserID", "createdAt" DESC, id DESC) WHERE deleted = false;
      CREATE INDEX "Notification_unread_recipient_type_idx"
        ON "Notification" ("toUserID", type) WHERE deleted = false AND read = false;

      INSERT INTO "Friend" SELECT 'fr' || g FROM generate_series(1, 50) g;
      INSERT INTO "GroupAdmission" SELECT 'ga' || g, 'conv' || (g % 10) FROM generate_series(1, 50) g;

      -- big:四万条,SYSTEM 每 4000 条才一条;另有一百个普通用户分走一半的行。
      INSERT INTO "Notification" (id, type, "toUserID", "fromUserID", "createdAt", deleted, read,
                                  "fromFriendRequestID", "fromGroupAdmissionID")
      SELECT 'n' || lpad(g::text, 6, '0'),
             (CASE WHEN g % 4000 = 0 THEN 'SYSTEM'
                   ELSE (${BIG_TYPE_ARRAY})[1 + g % ${BIG_TYPE_CYCLE.length}] END)::"NotificationType",
             CASE WHEN g % 2 = 0 THEN 'big' ELSE 'u' || (g % 100) END,
             'sender',
             timestamp '2026-10-01 00:00:00' - (g || ' seconds')::interval,
             g % 37 = 0,
             g % 3 = 0,
             CASE WHEN g % 1000 = 1 THEN 'fr' || (1 + g / 1000 % 50) END,
             CASE WHEN g % 1000 = 3 THEN 'ga' || (1 + g / 1000 % 50) END
      FROM generate_series(1, 80000) g;
    `);
    // big 的 SYSTEM:g % 4000 = 0 都是偶数 → 全落在 big 上(20 条)。
    for (const name of MIGRATIONS) {
      const migration = readFileSync(
        join(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      );
      // CONCURRENTLY 不能放进多语句的隐式事务:逐条执行,和 Prisma 部署时一样。
      for (const statement of statements(migration)) {
        await s.db.query(statement);
      }
    }
    await s.db.query('VACUUM ANALYZE "Notification"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('swaps the three indexes and keeps the rest', async () => {
    const names = await indexNames();

    expect(names).toEqual(
      expect.arrayContaining([
        'Notification_active_recipient_created_type_idx',
        'Notification_fromFriendRequestID_present_idx',
        'Notification_fromGroupAdmissionID_present_idx',
        // 管理台按收件人筛推送、退群清理等查询不带 deleted = false,还要靠它。
        'Notification_toUserID_idx',
        'Notification_unread_recipient_type_idx',
        'Notification_createdAt_idx',
      ]),
    );
    expect(names).not.toContain('Notification_active_recipient_created_idx');
    expect(names).not.toContain('Notification_fromFriendRequestID_idx');
    expect(names).not.toContain('Notification_fromGroupAdmissionID_idx');
  });

  it('pages the system inbox with type as an index condition, never per-row heap checks', async () => {
    const input = {
      userId: 'big',
      types: PROFILE_NOTIFICATION_TYPES,
      limit: 21,
    };

    expect((await scan(input)).map((row) => row.id)).toEqual(
      await reference('big', PROFILE_NOTIFICATION_TYPES, 21),
    );
    const q = notificationPageScanQuery(input);
    const plan = await explainPlan(s.db, q.text, q.values);
    expect(plan).toContain('Notification_active_recipient_created_type_idx');
    // type 进了 Index Cond(不是回表后的 Filter)。
    expect(plan).toMatch(/"Index Cond":"[^}]*type = 'SYSTEM'/);
    expect(plan).not.toContain('"Filter"');
    expect(plan).not.toContain('"Node Type":"Sort"');
  });

  it('pages a multi-type bell from the index alone, in order', async () => {
    const input = {
      userId: 'big',
      types: MOMENT_NOTIFICATION_TYPES,
      limit: 21,
    };

    expect((await scan(input)).map((row) => row.id)).toEqual(
      await reference('big', MOMENT_NOTIFICATION_TYPES, 21),
    );
    const q = notificationPageScanQuery(input);
    const plan = await explainPlan(s.db, q.text, q.values);
    expect(plan).toContain('"Node Type":"Index Only Scan"');
    expect(plan).toContain('Notification_active_recipient_created_type_idx');
    expect(plan).not.toContain('"Node Type":"Sort"');
  });

  it('continues a keyset cursor through the same index', async () => {
    const first = await scan({
      userId: 'big',
      types: CIRCLE_NOTIFICATION_TYPES,
      limit: 21,
    });
    const last = first[19];
    const input = {
      userId: 'big',
      types: CIRCLE_NOTIFICATION_TYPES,
      limit: 21,
      before: { createdAt: last.createdAt, id: last.id },
    };

    const next = await scan(input);
    expect(next.map((row) => row.id)).toEqual(
      await reference('big', CIRCLE_NOTIFICATION_TYPES, 21, 20),
    );
    const q = notificationPageScanQuery(input);
    const plan = await explainPlan(s.db, q.text, q.values);
    expect(plan).toContain('Notification_active_recipient_created_type_idx');
    expect(plan).not.toContain('"Node Type":"Sort"');
  });

  it('keeps the legacy page offset semantics', async () => {
    const rows = await scan({
      userId: 'big',
      types: DISCOVER_NOTIFICATION_TYPES,
      limit: 20,
      offset: 40,
    });

    expect(rows.map((row) => row.id)).toEqual(
      await reference('big', DISCOVER_NOTIFICATION_TYPES, 20, 40),
    );
  });

  it('sums the grouped unread counts exactly like the old per-domain counts', async () => {
    for (const userId of ['big', 'u1', 'u42', 'nobody']) {
      const q = unreadNotificationCountsByTypeQuery(userId);
      const { rows } = await s.db.query<UnreadNotificationCountRow>(
        q.text,
        q.values,
      );
      const oldCount = async (types: readonly string[]) => {
        const result = await s.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "Notification"
           WHERE "toUserID" = $1 AND deleted = false AND read = false
             AND type::text = ANY($2::text[])`,
          [userId, types],
        );
        return result.rows[0].n;
      };

      expect(sumUnreadNotificationsByDomain(rows)).toEqual({
        discoverUnread: await oldCount(DISCOVER_NOTIFICATION_TYPES),
        momentsUnread: await oldCount(MOMENT_NOTIFICATION_TYPES),
        circleUnread: await oldCount(CIRCLE_NOTIFICATION_TYPES),
        profileUnread: await oldCount(PROFILE_NOTIFICATION_TYPES),
      });
    }
  });

  it('reads the grouped unread counts from the unread partial index alone', async () => {
    const q = unreadNotificationCountsByTypeQuery('big');
    const plan = await explainPlan(s.db, q.text, q.values);

    expect(plan).toContain('Notification_unread_recipient_type_idx');
    expect(plan).toContain('"Node Type":"Index Only Scan"');
  });

  it('serves every group-admission lookup from the sparse partial index', async () => {
    const seen = await explainPlan(s.db, GROUP_ADMISSION_SEEN_SQL, [
      'big',
      'ga1',
      false,
      false,
      0,
    ]);
    expect(seen).toContain('Notification_fromGroupAdmissionID_present_idx');

    const unread = await explainPlan(s.db, GROUP_ADMISSION_UNREAD_SQL, [
      'big',
      'GROUP_ADMISSION',
      false,
      false,
      'ga1',
      'ga2',
      0,
    ]);
    expect(unread).toContain('Notification_fromGroupAdmissionID_present_idx');

    await s.db.query('SET enable_seqscan = off');
    try {
      const leave = await explainPlan(s.db, GROUP_LEAVE_SQL, [
        true,
        'big',
        false,
        'conv1',
      ]);
      // 半连接的连接条件同样隐含 IS NOT NULL:参数化内表扫描可以走部分索引。
      expect(leave).toContain('Notification_fromGroupAdmissionID_present_idx');
    } finally {
      await s.db.query('RESET enable_seqscan');
    }
  });

  it('keeps the friend-request foreign key action on the sparse partial index', async () => {
    const plan = await explainPlan(s.db, FRIEND_SET_NULL_SQL, ['fr2']);
    expect(plan).toContain('Notification_fromFriendRequestID_present_idx');

    await s.db.query('BEGIN');
    try {
      const before = await s.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Notification" WHERE "fromFriendRequestID" = 'fr2'`,
      );
      expect(before.rows[0].n).toBeGreaterThan(0);
      await s.db.query(`DELETE FROM "Friend" WHERE id = 'fr2'`);
      const after = await s.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Notification" WHERE "fromFriendRequestID" = 'fr2'`,
      );
      expect(after.rows[0].n).toBe(0);
    } finally {
      await s.db.query('ROLLBACK');
    }
  });
});
