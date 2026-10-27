import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approvedInvitationsToReconcileQuery,
  pendingConsentDeliveriesQuery,
} from 'src/circle-invitation/circle-invitation-cron.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * 圈子邀请两个定时任务的批次查询在真 PostgreSQL 上的口径与成本（迁移 20261026000520）：
 * 原有索引下两条都是整表扫描；建了部分索引后各自落在自己的索引上，结果口径不变。
 */
describePostgres('circle invitation cron batch queries (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const capture = capturePrisma();

  const MIGRATION =
    'prisma/migrations/20261026000520_circle_invitation_cron_indexes/migration.sql';
  const CONSENT_INDEX = 'CircleInvitation_consent_delivery_idx';
  const RECONCILE_INDEX = 'CircleInvitation_reconcile_approved_idx';

  type Invitation = {
    status?: string;
    consentNoticeRequired?: boolean;
    consentNoticeDeliveredAt?: string | null;
    consentNoticeAttempts?: number;
    requiredCount?: number;
    approvedCount?: number;
    createdAt?: string;
    updatedAt?: string;
  };

  const insertInvitation = async (id: string, row: Invitation) => {
    await s.db.query(
      `INSERT INTO "CircleInvitation" (
         id, "circleID", "applicantID", status, "consentNoticeRequired",
         "consentNoticeDeliveredAt", "consentNoticeAttempts", "requiredCount",
         "approvedCount", "createdAt", "updatedAt")
       VALUES ($1, 'circle', 'applicant-' || $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        row.status ?? 'PENDING',
        row.consentNoticeRequired ?? false,
        row.consentNoticeDeliveredAt ?? null,
        row.consentNoticeAttempts ?? 0,
        row.requiredCount ?? 10,
        row.approvedCount ?? 0,
        row.createdAt ?? '2026-10-01 00:00:00',
        row.updatedAt ?? '2026-10-01 00:00:00',
      ],
    );
  };

  const run = async <T>(q: { text: string; values: unknown[] }) =>
    (await s.db.query<T & Record<string, unknown>>(q.text, q.values)).rows;

  const applyMigration = async () => {
    // CREATE INDEX CONCURRENTLY 不能放进多语句的隐式事务，和 Prisma 一样逐条执行。
    const statements = readFileSync(join(process.cwd(), MIGRATION), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      await s.db.query(statement);
    }
  };

  const withIndexPreference = async <T>(fn: () => Promise<T>) => {
    await s.db.query('SET enable_seqscan = off');
    try {
      return await fn();
    } finally {
      await s.db.query('RESET enable_seqscan');
    }
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('circle_invitation_cron');
    await s.db.query(`
      CREATE TYPE "CircleInvitationStatus" AS ENUM
        ('INVITED', 'PENDING', 'APPROVED', 'REJECTED', 'ADMIN_APPROVED', 'CANCELLED');
      CREATE TABLE "CircleInvitation" (
        id text PRIMARY KEY,
        "circleID" text NOT NULL,
        "applicantID" text NOT NULL,
        "consentNoticeDeliveredAt" timestamp(3),
        "consentNoticeAttempts" int NOT NULL DEFAULT 0,
        "consentNoticeRequired" boolean NOT NULL DEFAULT false,
        "requiredCount" int NOT NULL DEFAULT 1,
        "approvedCount" int NOT NULL DEFAULT 0,
        status "CircleInvitationStatus" NOT NULL DEFAULT 'PENDING',
        "createdAt" timestamp(3) NOT NULL,
        "updatedAt" timestamp(3) NOT NULL
      );
      -- 线上已有的两条索引。
      CREATE INDEX "CircleInvitation_circleID_status_idx"
        ON "CircleInvitation" ("circleID", status);
      CREATE INDEX "CircleInvitation_applicantID_idx"
        ON "CircleInvitation" ("applicantID");
    `);
    // 大量已经结案 / 正常进行中的邀请，待处理的只是零头。
    await s.db.query(`
      INSERT INTO "CircleInvitation" (
        id, "circleID", "applicantID", status, "consentNoticeRequired",
        "consentNoticeDeliveredAt", "requiredCount", "approvedCount", "createdAt", "updatedAt")
      SELECT 'filler-' || g, 'circle-' || (g % 50), 'user-' || g,
             (ARRAY['APPROVED', 'PENDING', 'REJECTED', 'INVITED', 'CANCELLED'])[g % 5 + 1]::"CircleInvitationStatus",
             g % 2 = 0, CASE WHEN g % 2 = 0 THEN TIMESTAMP '2026-09-01' END,
             10, g % 10, TIMESTAMP '2026-09-01' + (g || ' seconds')::interval,
             TIMESTAMP '2026-09-01' + (g || ' seconds')::interval
      FROM generate_series(1, 5000) g
    `);
    await s.db.query('ANALYZE "CircleInvitation"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('full-scans the table for both cron batches with only the original indexes', async () => {
    const consent = pendingConsentDeliveriesQuery({
      maxAttempts: 8,
      limit: 50,
    });
    const reconcile = approvedInvitationsToReconcileQuery();

    // 没有以 status 打头的索引：规划器只能整表扫描（强行关掉顺序扫描的话，也只是把
    // (circleID, status) 整条索引读一遍）。
    for (const q of [consent, reconcile]) {
      const plan = await explainPlan(s.db, q.text, q.values);
      expect(plan).toContain('"Node Type":"Seq Scan"');
    }
  });

  describe('with the cron partial indexes', () => {
    beforeAll(async () => {
      await applyMigration();
      await s.db.query('ANALYZE "CircleInvitation"');
    });

    afterEach(async () => {
      await s.db.query(`DELETE FROM "CircleInvitation" WHERE id LIKE 't-%'`);
    });

    it('selects undelivered consent invitations by attempts then age, under the attempt cap', async () => {
      const due = {
        status: 'INVITED',
        consentNoticeRequired: true,
      } as const;
      await insertInvitation('t-a1-old', {
        ...due,
        consentNoticeAttempts: 1,
        createdAt: '2026-10-01 00:00:00',
      });
      await insertInvitation('t-a0-new', {
        ...due,
        createdAt: '2026-10-03 00:00:00',
      });
      await insertInvitation('t-a0-old', {
        ...due,
        createdAt: '2026-10-02 00:00:00',
      });
      // 不在口径内：用完重试、已投递、不需要同意、已离开 INVITED。
      await insertInvitation('t-exhausted', {
        ...due,
        consentNoticeAttempts: 8,
      });
      await insertInvitation('t-delivered', {
        ...due,
        consentNoticeDeliveredAt: '2026-10-04 00:00:00',
      });
      await insertInvitation('t-no-consent', {
        status: 'INVITED',
        consentNoticeRequired: false,
      });
      await insertInvitation('t-pending', {
        status: 'PENDING',
        consentNoticeRequired: true,
      });

      const all = await run<{ id: string }>(
        pendingConsentDeliveriesQuery({ maxAttempts: 8, limit: 50 }),
      );
      // filler 里的 INVITED 行都不需要同意或已投递，口径里只剩测试行。
      expect(all.map((row) => row.id)).toEqual([
        't-a0-old',
        't-a0-new',
        't-a1-old',
      ]);
      const capped = await run<{ id: string }>(
        pendingConsentDeliveriesQuery({ maxAttempts: 1, limit: 1 }),
      );
      expect(capped.map((row) => row.id)).toEqual(['t-a0-old']);
    });

    it('selects only stuck PENDING invitations with enough approvals, oldest first', async () => {
      await insertInvitation('t-stuck-2', {
        requiredCount: 1,
        approvedCount: 1,
        updatedAt: '2026-10-02 00:00:00',
      });
      await insertInvitation('t-stuck-1', {
        requiredCount: 10,
        approvedCount: 11,
        updatedAt: '2026-10-01 00:00:00',
      });
      await insertInvitation('t-short', {
        requiredCount: 10,
        approvedCount: 9,
      });
      await insertInvitation('t-approved', {
        status: 'APPROVED',
        requiredCount: 1,
        approvedCount: 1,
      });

      const rows = await run<{ id: string; applicantID: string }>(
        approvedInvitationsToReconcileQuery(),
      );
      expect(rows.map((row) => row.id)).toEqual(['t-stuck-1', 't-stuck-2']);
      expect(rows[0]).toEqual({
        id: 't-stuck-1',
        circleID: 'circle',
        applicantID: 'applicant-t-stuck-1',
      });
    });

    it('reads each batch through its own partial index', async () => {
      const consent = pendingConsentDeliveriesQuery({
        maxAttempts: 8,
        limit: 50,
      });
      const reconcile = approvedInvitationsToReconcileQuery();

      // 不用关顺序扫描：部分索引只收待处理的行，规划器自己就会选它。
      const consentPlan = await explainPlan(s.db, consent.text, consent.values);
      const reconcilePlan = await explainPlan(
        s.db,
        reconcile.text,
        reconcile.values,
      );
      expect(consentPlan).toContain(CONSENT_INDEX);
      expect(reconcilePlan).toContain(RECONCILE_INDEX);
      // 两条的键序就是 ORDER BY，读到 LIMIT 条就停，不需要排序节点。
      for (const plan of [consentPlan, reconcilePlan]) {
        expect(plan).not.toContain('"Node Type":"Seq Scan"');
        expect(plan).not.toContain('"Node Type":"Sort"');
      }
    });

    it('could not use the consent index through Prisma\u2019s parameterized enum filter', async () => {
      // 对照：改造前的 circleInvitation.findMany，现场编译出 Prisma 的真实 SQL。枚举条件
      // 是 CAST($n::text AS 枚举)，enum_in 是 STABLE，规划期折叠不成常量，部分索引的
      // 谓词证明不了 —— 这就是批次查询必须是原生 SQL 的原因，别再「简化」回 findMany。
      const [prismaShape] = await captureQueries(capture.queries, () =>
        capture.prisma.circleInvitation.findMany({
          where: {
            consentNoticeDeliveredAt: null,
            consentNoticeRequired: true,
            status: 'INVITED',
            consentNoticeAttempts: { lt: 8 },
          },
          orderBy: [{ consentNoticeAttempts: 'asc' }, { createdAt: 'asc' }],
          take: 50,
          select: { id: true, consentNoticeAttempts: true },
        }),
      );
      expect(prismaShape.sql).toContain('CAST(');

      const plan = await withIndexPreference(() =>
        explainPlan(s.db, prismaShape.sql, prismaShape.args),
      );
      expect(plan).not.toContain(CONSENT_INDEX);
    });
  });
});
