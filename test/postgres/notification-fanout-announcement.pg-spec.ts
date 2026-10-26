import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  NotificationType,
  PrismaClient,
  UserStatus,
} from 'src/generated/prisma';
import { PROFILE_NOTIFICATION_TYPES } from 'src/notification/notification.constants';
import {
  profileUnreadCountsByRecipientQuery,
  type ProfileUnreadCountRow,
} from 'src/notification/notification-profile-unread.query';
import { NotificationService } from 'src/notification/notification.service';
import {
  describePostgres,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 系统公告的发布 / 编辑 / 删除在真 PostgreSQL 16 + 真 PrismaClient 上:
 * - 发布:互斥改成 Redis 租约后,扇出期间这个应用的连接里没有 idle in transaction;
 *   退回数据库锁(Redis 不可用)时仍是改动前的形状,扇出结果两条路径完全一样;
 * - 扇出后的未读广播:整批一条 GROUP BY,与逐人 count 逐项相等,走未读部分索引;
 * - 编辑 / 删除:按收件人键集每批 1000 行分批提交,最终数据与改动前「一条 updateMany
 *   改全员」逐行一致;翻页走唯一索引,不排序。
 */
const KEY_MIGRATION = '20261026000800_push_outbox_fairness_key';
const APP_NAME = `announcement_pg_${process.pid}`;
const ACTIVE_RECIPIENTS = 1250;

const quoted = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

/** 只有 runWithJobLease 用到的三个方法;lease = undefined 模拟 Redis 答不上来。 */
function fakeRedis(mode: 'available' | 'unavailable') {
  const held = new Map<string, string>();
  return {
    tryAcquireLease: async (key: string) => {
      if (mode === 'unavailable') return undefined;
      if (held.has(key)) return null;
      const token = `token-${held.size + 1}`;
      held.set(key, token);
      return token;
    },
    renewLease: async (key: string, token: string) => held.get(key) === token,
    releaseLease: async (key: string, token: string) => {
      if (held.get(key) === token) held.delete(key);
    },
  };
}

describePostgres(
  'system announcement fan-out, edit and delete (PostgreSQL)',
  () => {
    let s: IsolatedSchema;
    let prisma: PrismaClient;
    const audit = { recordStrict: jest.fn(async () => undefined) };
    /** 每批广播时采样一次:这个应用的连接里有几个 idle in transaction。 */
    let idleInTransactionSamples: number[] = [];
    let broadcastRecipients: string[] = [];
    const realtime = {
      broadcastSystemNotificationUnreadToRecipients: async (
        userIds: readonly string[],
      ) => {
        const { rows } = await s.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE application_name = $1 AND state = 'idle in transaction'`,
          [APP_NAME],
        );
        idleInTransactionSamples.push(rows[0].n);
        broadcastRecipients.push(...userIds);
      },
      broadcastAnnouncementChanged: async () => undefined,
    };

    const service = (redisMode: 'available' | 'unavailable') =>
      new NotificationService(
        prisma as never,
        realtime as never,
        undefined,
        audit as never,
        fakeRedis(redisMode) as never,
      );

    const publish = async (
      redisMode: 'available' | 'unavailable',
      idempotencyKey: string,
    ) => {
      idleInTransactionSamples = [];
      broadcastRecipients = [];
      const result = await service(redisMode).publishSystemAnnouncement(
        'admin-1',
        { title: 'Maintenance', content: 'Maintenance tonight' },
        idempotencyKey,
      );
      const { rows } = await s.db.query<{ id: string }>(
        `SELECT id FROM "SystemAnnouncement" WHERE "idempotencyKey" = $1`,
        [idempotencyKey],
      );
      return { ...result, id: rows[0].id };
    };

    /** 一条公告的收件人侧全部状态,按 fromUserID(= 收件人,toUserID 被置空也不变)排序。 */
    const snapshot = async (announcementID: string) => {
      const { rows } = await s.db.query(
        `SELECT n."fromUserID" AS recipient, n."toUserID" IS NULL AS orphan,
              n.content, n.deleted, n.read,
              o.status::text AS outbox_status, o.payload IS NULL AS payload_cleared,
              o."completionReason", o."leaseToken", o."lockedAt",
              COALESCE(json_agg(json_build_object('token', d.token, 'status', d.status::text,
                                                  'lastError', d."lastError")
                                ORDER BY d.token) FILTER (WHERE d.id IS NOT NULL), '[]') AS deliveries
       FROM "Notification" n
       JOIN "NotificationPushOutbox" o ON o."notificationID" = n.id
       LEFT JOIN "NotificationPushDelivery" d ON d."outboxID" = o.id
       WHERE n."systemAnnouncementID" = $1
       GROUP BY n.id, o.id
       ORDER BY n."fromUserID"`,
        [announcementID],
      );
      return rows;
    };

    const announcementRow = async (id: string) => {
      const { rows } = await s.db.query(
        `SELECT title, content, scrolling, "deletedAt" IS NOT NULL AS deleted
       FROM "SystemAnnouncement" WHERE id = $1`,
        [id],
      );
      return rows[0];
    };

    beforeAll(async () => {
      s = await openIsolatedSchema('announce');
      await s.db.query(`
      CREATE TYPE "NotificationType" AS ENUM (${quoted(Object.values(NotificationType))});
      CREATE TYPE "UserStatus" AS ENUM (${quoted(Object.values(UserStatus))});
      CREATE TYPE "NotificationPushOutboxStatus" AS ENUM
        ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'TERMINAL');
      CREATE TYPE "NotificationPushDeliveryStatus" AS ENUM
        ('PENDING', 'SENT', 'CONFIRMED', 'FAILED', 'TERMINAL');
      CREATE TABLE "User" (
        id text PRIMARY KEY,
        status "UserStatus" NOT NULL DEFAULT 'ACTIVE',
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "SystemAnnouncement" (
        id text PRIMARY KEY,
        "idempotencyKey" text NOT NULL,
        "requestFingerprint" text NOT NULL,
        title text,
        scrolling boolean NOT NULL DEFAULT false,
        "deletedAt" timestamp(3),
        "operatorID" text NOT NULL,
        content text NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "auditRecordedAt" timestamp(3),
        "fanoutCompletedAt" timestamp(3),
        "recipientCount" integer
      );
      CREATE UNIQUE INDEX "SystemAnnouncement_idempotencyKey_key"
        ON "SystemAnnouncement" ("idempotencyKey");
      CREATE TABLE "Notification" (
        id text PRIMARY KEY,
        content text NOT NULL DEFAULT '',
        deleted boolean NOT NULL DEFAULT false,
        read boolean NOT NULL DEFAULT false,
        type "NotificationType" NOT NULL,
        "toUserID" text,
        "fromUserID" text NOT NULL,
        "fromTraceID" text,
        "fromReplyID" text,
        "toReplyID" text,
        "fromCircleID" text,
        "fromCirclePostID" text,
        "fromInvitationID" text,
        "fromFriendRequestID" text,
        "fromGroupAdmissionID" text,
        "systemAnnouncementID" text REFERENCES "SystemAnnouncement"(id),
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE UNIQUE INDEX "Notification_announcement_recipient_key"
        ON "Notification" ("systemAnnouncementID", "toUserID");
      CREATE INDEX "Notification_toUserID_idx" ON "Notification" ("toUserID");
      CREATE INDEX "Notification_unread_recipient_type_idx"
        ON "Notification" ("toUserID", type) WHERE deleted = false AND read = false;
      CREATE TABLE "NotificationPushOutbox" (
        id text PRIMARY KEY,
        "notificationID" text NOT NULL REFERENCES "Notification"(id) ON DELETE CASCADE,
        status "NotificationPushOutboxStatus" NOT NULL DEFAULT 'PENDING',
        "leaseToken" text,
        attempts integer NOT NULL DEFAULT 0,
        "lastError" text,
        "nextAttemptAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "lockedAt" timestamp(3),
        "completionReason" text,
        "processedAt" timestamp(3),
        payload jsonb,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE UNIQUE INDEX "NotificationPushOutbox_notificationID_key"
        ON "NotificationPushOutbox" ("notificationID");
      CREATE TABLE "NotificationPushDelivery" (
        id text PRIMARY KEY,
        "outboxID" text NOT NULL REFERENCES "NotificationPushOutbox"(id) ON DELETE CASCADE,
        "notificationID" text NOT NULL,
        token text NOT NULL,
        "ticketID" text,
        status "NotificationPushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
        "lastError" text,
        attempts integer NOT NULL DEFAULT 0,
        "sentAt" timestamp(3),
        "receiptCheckedAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE UNIQUE INDEX "NotificationPushDelivery_notificationID_token_key"
        ON "NotificationPushDelivery" ("notificationID", token);
      CREATE INDEX "NotificationPushDelivery_outboxID_status_attempts_idx"
        ON "NotificationPushDelivery" ("outboxID", status, attempts);

      -- 收件人:活跃用户 + 封禁用户(不收)+ 公告之后才注册的用户(不收)。
      INSERT INTO "User" (id, status, "createdAt")
      SELECT 'user-' || lpad(g::text, 5, '0'), 'ACTIVE', now() - interval '1 day'
      FROM generate_series(1, ${ACTIVE_RECIPIENTS}) g;
      INSERT INTO "User" (id, status, "createdAt")
      SELECT 'banned-' || g, 'BANNED', now() - interval '1 day' FROM generate_series(1, 20) g;
      INSERT INTO "User" (id, status, "createdAt")
      SELECT 'later-' || g, 'ACTIVE', now() + interval '1 day' FROM generate_series(1, 10) g;
    `);
      // 出队公平键的触发器(推送 outbox 那一批):扇出写 outbox 时一并验证它填上了。
      await s.db.query(
        readFileSync(
          join(
            process.cwd(),
            'prisma/migrations',
            KEY_MIGRATION,
            'migration.sql',
          ),
          'utf8',
        ),
      );
      prisma = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: process.env.POSTGRES_TEST_DATABASE_URL,
            application_name: APP_NAME,
            // 原生 SQL 和触发器函数里的表名不带 schema 前缀,靠 search_path 落到隔离 schema。
            options: `-c search_path=${s.schema}`,
            max: 4,
          },
          { schema: s.schema },
        ),
      });
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      await s?.close();
    });

    describe('publish', () => {
      let leased: { createdCount: number; id: string };

      it('fans out without holding an idle transaction for the mutex', async () => {
        leased = await publish('available', 'announcement-leased');

        expect(leased.createdCount).toBe(ACTIVE_RECIPIENTS);
        // 1250 人 = 500 + 500 + 250 三批,每批广播时都没有占着锁的空闲事务。
        expect(idleInTransactionSamples).toEqual([0, 0, 0]);
        expect(new Set(broadcastRecipients).size).toBe(ACTIVE_RECIPIENTS);
        expect(broadcastRecipients).toHaveLength(ACTIVE_RECIPIENTS);
      });

      it('keeps the old database-lock shape only as the Redis-unavailable fallback, with the same result', async () => {
        const fallback = await publish('unavailable', 'announcement-fallback');

        // 改动前的形状:外层事务只为持有 advisory 锁,扇出期间一直 idle in transaction。
        expect(idleInTransactionSamples).toEqual([1, 1, 1]);
        expect(fallback.createdCount).toBe(leased.createdCount);

        const recipients = async (id: string) =>
          (
            await s.db.query<{ toUserID: string; fromUserID: string }>(
              `SELECT n."toUserID", n."fromUserID", o."fairnessKey", o.status::text
             FROM "Notification" n JOIN "NotificationPushOutbox" o ON o."notificationID" = n.id
             WHERE n."systemAnnouncementID" = $1 ORDER BY n."toUserID"`,
              [id],
            )
          ).rows;
        const viaLease = await recipients(leased.id);
        const viaFallback = await recipients(fallback.id);
        expect(viaLease).toHaveLength(ACTIVE_RECIPIENTS);
        expect(viaLease.map((row) => row.toUserID)).toEqual(
          viaFallback.map((row) => row.toUserID),
        );
        for (const row of viaLease) {
          expect(row).toEqual({
            toUserID: row.toUserID,
            fromUserID: row.toUserID,
            fairnessKey: `announcement:${leased.id}`,
            status: 'PENDING',
          });
        }
        for (const id of [leased.id, fallback.id]) {
          const { rows } = await s.db.query(
            `SELECT "recipientCount", "fanoutCompletedAt" IS NOT NULL AS completed
           FROM "SystemAnnouncement" WHERE id = $1`,
            [id],
          );
          expect(rows[0]).toEqual({
            recipientCount: ACTIVE_RECIPIENTS,
            completed: true,
          });
        }
      });

      it('rejects a second publish while the lease is held, like the database lock did', async () => {
        const redis = fakeRedis('available');
        await redis.tryAcquireLease('job-lease:system-announcement-fanout');
        const otherReplica = new NotificationService(
          prisma as never,
          realtime as never,
          undefined,
          audit as never,
          redis as never,
        );
        await expect(
          otherReplica.publishSystemAnnouncement(
            'admin-2',
            { content: 'Second' },
            'announcement-blocked',
          ),
        ).rejects.toMatchObject({ status: 429 });
        const { rows } = await s.db.query(
          `SELECT 1 FROM "SystemAnnouncement" WHERE "idempotencyKey" = 'announcement-blocked'`,
        );
        expect(rows).toHaveLength(0);
      });
    });

    describe('unread broadcast counts', () => {
      beforeAll(async () => {
        // 收件人在公告之外还有各种通知:类型、已读、删除全打散。
        await s.db.query(`
        INSERT INTO "Notification" (id, type, "toUserID", "fromUserID", deleted, read, "updatedAt")
        SELECT 'extra-' || g,
               (ARRAY['SYSTEM', 'TRACE_LIKE', 'TRACE_COMMENT', 'SYSTEM', 'FRIEND_REQUEST_RECEIVED'])[1 + g % 5]::"NotificationType",
               'user-' || lpad((1 + g % 300)::text, 5, '0'),
               'someone',
               g % 11 = 0,
               g % 4 = 0,
               now()
        FROM generate_series(1, 6000) g;
        UPDATE "Notification" SET read = true
        WHERE "systemAnnouncementID" IS NOT NULL AND "toUserID" < 'user-00100';
      `);
        await s.db.query('VACUUM ANALYZE "Notification"');
      });

      it('equals the per-recipient count the single-user broadcast used to run', async () => {
        const userIds = [
          ...Array.from(
            { length: 498 },
            (_, index) => `user-${String(index + 1).padStart(5, '0')}`,
          ),
          'banned-1',
          'nobody',
        ];
        const q = profileUnreadCountsByRecipientQuery(userIds);
        const { rows } = await s.db.query<ProfileUnreadCountRow>(
          q.text,
          q.values,
        );
        const grouped = new Map(rows.map((row) => [row.userId, row.count]));

        const { rows: perUser } = await s.db.query<{ id: string; n: number }>(
          `SELECT u.id, (
           SELECT count(*)::int FROM "Notification"
           WHERE "toUserID" = u.id AND deleted = false AND read = false
             AND type::text = ANY($2::text[])
         ) AS n
         FROM unnest($1::text[]) AS u(id)`,
          [userIds, [...PROFILE_NOTIFICATION_TYPES]],
        );
        expect(perUser.some((row) => row.n === 0)).toBe(true);
        expect(perUser.some((row) => row.n > 2)).toBe(true);
        for (const row of perUser) {
          expect(grouped.get(row.id) ?? 0).toBe(row.n);
        }
      });

      it('can read the whole batch from the unread partial index', async () => {
        const q = profileUnreadCountsByRecipientQuery(
          Array.from(
            { length: 500 },
            (_, index) => `user-${String(index + 1).padStart(5, '0')}`,
          ),
        );
        // 测试表很小(500 人占了收件人的四成),规划器有时直接全表扫更便宜。这里要证明的是
        // 部分索引的谓词能从查询里推出来(deleted / read 是字面量)—— 生产上 500 人只是
        // 表里极小的一部分,能用就会用。
        await s.db.query('SET enable_seqscan = off');
        try {
          const { rows } = await s.db.query<{ 'QUERY PLAN': unknown }>(
            `EXPLAIN (FORMAT JSON) ${q.text}`,
            q.values,
          );
          const plan = JSON.stringify(rows[0]['QUERY PLAN']);
          expect(plan).toContain('Notification_unread_recipient_type_idx');
          expect(plan).not.toContain('"Node Type":"Seq Scan"');
        } finally {
          await s.db.query('RESET enable_seqscan');
        }
      });
    });

    describe('edit and delete', () => {
      let target: string;
      let reference: string;

      /** 同一份收件人状态套在两条公告上:一条走新实现,一条跑改动前的单条语句。 */
      const seedRecipientStates = async (id: string) => {
        await s.db.query(
          `WITH rows AS (
           SELECT n.id, row_number() OVER (ORDER BY n."toUserID") AS i
           FROM "Notification" n WHERE n."systemAnnouncementID" = $1
         )
         UPDATE "Notification" n SET deleted = rows.i % 7 = 0, read = rows.i % 3 = 0
         FROM rows WHERE n.id = rows.id`,
          [id],
        );
        await s.db.query(
          `WITH rows AS (
           SELECT o.id, row_number() OVER (ORDER BY n."toUserID") AS i
           FROM "NotificationPushOutbox" o JOIN "Notification" n ON n.id = o."notificationID"
           WHERE n."systemAnnouncementID" = $1
         )
         UPDATE "NotificationPushOutbox" o
         SET status = (ARRAY['PENDING','FAILED','PROCESSING','COMPLETED','TERMINAL'])[1 + rows.i % 5]::"NotificationPushOutboxStatus",
             payload = '{"title":"composed"}',
             "leaseToken" = CASE WHEN rows.i % 5 = 2 THEN 'lease-' || rows.i END,
             "lockedAt" = CASE WHEN rows.i % 5 = 2 THEN timestamp '2026-10-26 00:00:00' END
         FROM rows WHERE o.id = rows.id`,
          [id],
        );
        await s.db.query(
          `INSERT INTO "NotificationPushDelivery" (id, "outboxID", "notificationID", token, status, "updatedAt")
         SELECT o.id || '-' || t.token, o.id, o."notificationID", t.token,
                (ARRAY['PENDING','SENT','FAILED','CONFIRMED'])[1 + (rows.i + t.k) % 4]::"NotificationPushDeliveryStatus",
                now()
         FROM (
           SELECT o.id, row_number() OVER (ORDER BY n."toUserID") AS i
           FROM "NotificationPushOutbox" o JOIN "Notification" n ON n.id = o."notificationID"
           WHERE n."systemAnnouncementID" = $1
         ) rows
         JOIN "NotificationPushOutbox" o ON o.id = rows.id
         CROSS JOIN (VALUES ('tok-a', 0), ('tok-b', 1)) AS t(token, k)
         WHERE rows.i % 4 = 0`,
          [id],
        );
        // 三个收件人账号被物理删除过的老行(外键 SET NULL):走 toUserID 为 NULL 的补段。
        await s.db.query(
          `UPDATE "Notification" SET "toUserID" = NULL
         WHERE "systemAnnouncementID" = $1 AND "toUserID" IN ('user-00007', 'user-00500', 'user-01249')`,
          [id],
        );
      };

      beforeAll(async () => {
        const targetRun = await publish(
          'available',
          'announcement-edit-target',
        );
        const referenceRun = await publish(
          'available',
          'announcement-edit-reference',
        );
        target = targetRun.id;
        reference = referenceRun.id;
        await seedRecipientStates(target);
        await seedRecipientStates(reference);
        await s.db.query('VACUUM ANALYZE "Notification"');
        expect(await snapshot(target)).toEqual(await snapshot(reference));
      });

      it('edits every recipient row in batches and ends exactly where the single statement did', async () => {
        const referenceBefore = await snapshot(reference);
        await service('available').editAnnouncement('admin-1', target, {
          title: 'Edited title',
          content: 'Edited body',
        });
        // 新实现没碰别的公告。
        expect(await snapshot(reference)).toEqual(referenceBefore);

        // 改动前 editAnnouncement 的三条语句(Prisma 编译形状,口径照抄)。
        await s.db.query('BEGIN');
        await s.db.query(
          `UPDATE "SystemAnnouncement" SET title = $2, content = $3 WHERE id = $1`,
          [reference, 'Edited title', 'Edited body'],
        );
        await s.db.query(
          `UPDATE "Notification" SET content = $2, "updatedAt" = now()
         WHERE "systemAnnouncementID" = $1 AND deleted = false`,
          [reference, 'Edited body'],
        );
        await s.db.query(
          `UPDATE "NotificationPushOutbox" SET payload = NULL, "updatedAt" = now()
         WHERE "notificationID" IN (SELECT id FROM "Notification" WHERE "systemAnnouncementID" = $1)
           AND status IN ('PENDING', 'FAILED')`,
          [reference],
        );
        await s.db.query('COMMIT');

        const after = await snapshot(target);
        expect(after).toEqual(await snapshot(reference));
        expect(await announcementRow(target)).toEqual(
          await announcementRow(reference),
        );
        // 确实改到了:活着的行是新正文,删掉的行保持原样,未发推送的快照被清空。
        expect(
          after.filter((row) => row.content === 'Edited body'),
        ).toHaveLength(after.filter((row) => !row.deleted).length);
        expect(after.some((row) => row.payload_cleared)).toBe(true);
        expect(after.filter((row) => row.orphan)).toHaveLength(3);
      });

      it('deletes every recipient row in batches and ends exactly where the single statements did', async () => {
        await service('available').deleteAnnouncement('admin-1', target);

        await s.db.query('BEGIN');
        await s.db.query(
          `UPDATE "SystemAnnouncement" SET "deletedAt" = now(), scrolling = false WHERE id = $1`,
          [reference],
        );
        await s.db.query(
          `UPDATE "Notification" SET deleted = true, "updatedAt" = now()
         WHERE "systemAnnouncementID" = $1`,
          [reference],
        );
        await s.db.query(
          `UPDATE "NotificationPushOutbox"
         SET status = 'TERMINAL', "completionReason" = 'ANNOUNCEMENT_DELETED',
             "leaseToken" = NULL, "lockedAt" = NULL, "updatedAt" = now()
         WHERE "notificationID" IN (SELECT id FROM "Notification" WHERE "systemAnnouncementID" = $1)
           AND status IN ('PENDING', 'FAILED', 'PROCESSING')`,
          [reference],
        );
        await s.db.query(
          `UPDATE "NotificationPushDelivery"
         SET status = 'TERMINAL', "lastError" = 'ANNOUNCEMENT_DELETED', "updatedAt" = now()
         WHERE "outboxID" IN (
             SELECT o.id FROM "NotificationPushOutbox" o
             JOIN "Notification" n ON n.id = o."notificationID"
             WHERE n."systemAnnouncementID" = $1)
           AND status IN ('PENDING', 'FAILED')`,
          [reference],
        );
        await s.db.query('COMMIT');

        const after = await snapshot(target);
        expect(after).toEqual(await snapshot(reference));
        expect(await announcementRow(target)).toEqual(
          await announcementRow(reference),
        );
        expect(after.every((row) => row.deleted)).toBe(true);
        expect(
          after.some((row) => row.completionReason === 'ANNOUNCEMENT_DELETED'),
        ).toBe(true);
        await expect(
          service('available').deleteAnnouncement('admin-1', target),
        ).rejects.toMatchObject({ status: 404 });
      });
    });

    describe('recipient paging cost for a large announcement', () => {
      const BIG = 'announcement-big';
      const BIG_RECIPIENTS = 30_000;
      let logged: PrismaClient;
      const executed: Array<{ sql: string; args: unknown[] }> = [];

      type PlanNode = {
        'Node Type': string;
        'Actual Rows'?: number;
        'Actual Loops'?: number;
        'Rows Removed by Filter'?: number;
        'Index Name'?: string;
        Plans?: PlanNode[];
      };
      const nodes = (node: PlanNode): PlanNode[] => [
        node,
        ...(node.Plans ?? []).flatMap(nodes),
      ];
      const explain = async (sql: string, args: unknown[]) => {
        const { rows } = await s.db.query<{
          'QUERY PLAN': Array<{ Plan: PlanNode }>;
        }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, args);
        return nodes(rows[0]['QUERY PLAN'][0].Plan);
      };
      /** 一个节点总共摸过多少行:吐出的 + 被过滤掉的,乘以执行次数。 */
      const rowsTouched = (node: PlanNode) =>
        ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) *
        (node['Actual Loops'] ?? 1);

      beforeAll(async () => {
        await s.db.query(
          `INSERT INTO "SystemAnnouncement"
           (id, "idempotencyKey", "requestFingerprint", "operatorID", content, "fanoutCompletedAt")
         VALUES ($1, $1, 'fp', 'admin-1', 'Big', now())`,
          [BIG],
        );
        await s.db.query(
          `INSERT INTO "Notification" (id, type, "toUserID", "fromUserID", "systemAnnouncementID", "updatedAt")
         SELECT md5('big' || g), 'SYSTEM',
                CASE WHEN g % 10000 = 0 THEN NULL ELSE 'big-user-' || lpad(g::text, 6, '0') END,
                'big-user-' || lpad(g::text, 6, '0'), $1, now()
         FROM generate_series(1, ${BIG_RECIPIENTS}) g`,
          [BIG],
        );
        // 同一批用户的日常通知(每人 4 条):生产里公告行只是 Notification 的一小部分,
        // 沿 toUserID 单列索引扫会把每个人的所有通知都过一遍。
        await s.db.query(
          `INSERT INTO "Notification" (id, type, "toUserID", "fromUserID", "updatedAt")
         SELECT md5('noise' || g), 'TRACE_LIKE',
                'big-user-' || lpad((1 + g % ${BIG_RECIPIENTS})::text, 6, '0'), 'someone', now()
         FROM generate_series(1, ${BIG_RECIPIENTS * 4}) g`,
        );
        await s.db.query('VACUUM ANALYZE "Notification"');
        // 记下真实执行的每条语句(源码里的 Prisma 调用编译出来的),再拿去 EXPLAIN。
        logged = new PrismaClient({
          adapter: new PrismaPg(
            {
              connectionString: process.env.POSTGRES_TEST_DATABASE_URL,
              options: `-c search_path=${s.schema}`,
              max: 2,
            },
            { schema: s.schema },
          ),
          log: [{ emit: 'event', level: 'query' }],
        });
        logged.$on('query', (event) => {
          executed.push({
            sql: event.query,
            args: JSON.parse(event.params) as unknown[],
          });
        });
      });

      afterAll(async () => {
        await logged?.$disconnect();
      });

      it('pages every batch along the unique index without sorting, unlike the old id cursor', async () => {
        const pagingService = new NotificationService(
          logged as never,
          realtime as never,
        );
        let batches = 0;
        await (
          pagingService as unknown as {
            forEachAnnouncementRecipientBatch: (
              id: string,
              apply: (tx: unknown, ids: string[]) => Promise<boolean>,
            ) => Promise<void>;
          }
        ).forEachAnnouncementRecipientBatch(BIG, async (_tx, ids) => {
          batches += 1;
          expect(ids.length).toBeLessThanOrEqual(1000);
          return true;
        });
        // 29997 个有收件人的行 = 30 批(最后一批 997),再加 3 个孤儿行一批。
        expect(batches).toBe(31);

        const pages = executed.filter((query) =>
          /FROM "[^"]+"\."Notification"/.test(query.sql),
        );
        expect(pages.length).toBeGreaterThanOrEqual(31);
        let newTotal = 0;
        for (const page of pages) {
          const plan = await explain(page.sql, page.args);
          expect(plan.map((node) => node['Index Name'])).toContain(
            'Notification_announcement_recipient_key',
          );
          // 每批只读自己那 1000 行(孤儿段按 id 排的是那几行孤儿,同样很小)。
          const touched = Math.max(...plan.map(rowsTouched));
          expect(touched).toBeLessThanOrEqual(1000);
          newTotal += touched;
          if (/IS NOT NULL|"toUserID" > /.test(page.sql)) {
            expect(plan.map((node) => node['Node Type'])).not.toContain('Sort');
          }
        }
        expect(newTotal).toBeLessThanOrEqual(BIG_RECIPIENTS + 1000);

        // 改动前的 id 游标(notifyAnnouncementChanged 原来的翻页):没有
        // (systemAnnouncementID, id) 索引,每一页要么把这条公告的全部行取出来排序,要么
        // 沿主键扫、把别人的通知一行行过滤掉 —— 整轮读的是「全表」而不是「这条公告」。
        let legacyTotal = 0;
        let cursor: string | null = null;
        for (;;) {
          const sql = `SELECT id, "toUserID" FROM "Notification"
          WHERE "systemAnnouncementID" = $1 ${cursor ? 'AND id > $2' : ''}
          ORDER BY id ASC LIMIT 500`;
          const args = cursor ? [BIG, cursor] : [BIG];
          legacyTotal += Math.max(
            ...(await explain(sql, args)).map(rowsTouched),
          );
          const { rows } = await s.db.query<{ id: string }>(sql, args);
          if (rows.length < 500) break;
          cursor = rows[rows.length - 1].id;
        }
        expect(legacyTotal).toBeGreaterThan(newTotal * 3);
      });
    });
  },
);
