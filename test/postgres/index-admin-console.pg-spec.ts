import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from 'src/prisma/prisma.service';
import { AdminUserService } from 'src/admin-user/admin-user.service';
import { AdminAuditQueryService } from 'src/admin-operations/admin-audit-query.service';
import { ConsoleOperationsService } from 'src/admin-console/console-operations.service';
import { ConsoleInsightsService } from 'src/admin-console/console-insights.service';
import {
  buildAdminListCountQuery,
  buildAdminListPageQuery,
} from 'src/admin-access/admin-access-list.query';
import { ConfigService } from '@nestjs/config';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * 管理台三组索引(20261026000420 / 0430 / 0440)在真 PostgreSQL 上的效果。
 *
 * Prisma 查询的 SQL 都是被测 service 用假 adapter 现场编译出来的(prisma-sql-capture),
 * 管理员列表用的是 src 里导出的同一个 SQL 构造器。
 */
const MIGRATIONS = [
  '20261026000420_admin_user_search_indexes',
  '20261026000430_push_outbox_created_index',
  '20261026000440_admin_audit_created_index',
];

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('admin console indexes (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const capture = capturePrisma();
  const prisma = capture.prisma as unknown as PrismaService;

  // 表小,先关顺序扫描;before 里的语句(SET LOCAL / 事务内 DROP INDEX)随 ROLLBACK 撤销。
  const plan = async (
    sql: string,
    values: unknown[],
    before: string[] = [],
  ) => {
    await s.db.query('BEGIN');
    try {
      await s.db.query('SET LOCAL enable_seqscan = off');
      for (const statement of before) await s.db.query(statement);
      return await explainPlan(s.db, sql, values);
    } finally {
      await s.db.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('admin_console_idx');
    await s.db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await s.db.query(`
      CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
      CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED', 'DELETED');
      CREATE TABLE "User" (
        id text PRIMARY KEY, "accountId" text NOT NULL, nickname text NOT NULL,
        "avatarUrl" text, email text, "phoneNumber" text,
        role "UserRole" NOT NULL DEFAULT 'USER', status "UserStatus" NOT NULL DEFAULT 'ACTIVE',
        "createdAt" timestamp(3) NOT NULL, "lastOnline" timestamp(3)
      );
      CREATE UNIQUE INDEX "User_accountId_key" ON "User"("accountId");
      CREATE UNIQUE INDEX "User_email_key" ON "User"(email);
      CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
      CREATE INDEX "User_status_createdAt_idx" ON "User"(status, "createdAt");
      CREATE INDEX "User_accountId_trgm_idx" ON "User" USING gin ("accountId" gin_trgm_ops);
      CREATE INDEX "User_nickname_trgm_idx" ON "User" USING gin (nickname gin_trgm_ops);
      CREATE TABLE "AdminAccess" ("userID" text PRIMARY KEY, role text NOT NULL, version integer NOT NULL DEFAULT 1);

      INSERT INTO "User" (id, "accountId", nickname, email, "phoneNumber", role, status, "createdAt")
      SELECT 'u' || g, 'acct' || g, '昵称' || g,
        CASE WHEN g % 3 = 0 THEN 'user' || g || '@example.com' END,
        CASE WHEN g % 4 = 0 THEN '1380000' || lpad(g::text, 4, '0') END,
        'USER', CASE WHEN g % 50 = 0 THEN 'BANNED'::"UserStatus" ELSE 'ACTIVE' END,
        timestamp '2026-01-01' + g * interval '1 minute'
      FROM generate_series(1, 20000) g;
      -- 同一分钟里建的管理员:排序必须靠 id 兜底。
      INSERT INTO "User" (id, "accountId", nickname, role, status, "createdAt") VALUES
        ('a1', 'ops_alpha', '运营 A', 'ADMIN', 'ACTIVE', '2026-03-01 00:00'),
        ('a2', 'ops_beta', '运营 B', 'ADMIN', 'BANNED', '2026-03-01 00:00'),
        ('a3', 'ops_100%', '审核_一', 'ADMIN', 'ACTIVE', '2026-02-01 00:00'),
        ('a4', 'ops_gone', '已删除', 'ADMIN', 'DELETED', '2026-04-01 00:00'),
        ('a5', 'audit_x', 'Ops 大写', 'ADMIN', 'ACTIVE', '2026-01-15 00:00');
      INSERT INTO "AdminAccess" ("userID", role, version) VALUES ('a1', 'SUPER_ADMIN', 3), ('a3', 'AUDITOR', 1);

      CREATE TYPE "NotificationPushOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'TERMINAL');
      CREATE TABLE "NotificationPushOutbox" (
        id text PRIMARY KEY, "notificationID" text NOT NULL UNIQUE,
        status "NotificationPushOutboxStatus" NOT NULL DEFAULT 'PENDING',
        attempts integer NOT NULL DEFAULT 0, "lastError" text,
        "nextAttemptAt" timestamp(3) NOT NULL DEFAULT now(), "completionReason" text,
        "createdAt" timestamp(3) NOT NULL, "updatedAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "NotificationPushOutbox_status_nextAttemptAt_idx" ON "NotificationPushOutbox"(status, "nextAttemptAt");
      INSERT INTO "NotificationPushOutbox" (id, "notificationID", status, "createdAt", "updatedAt")
      SELECT md5('o' || g), 'n' || g, 'COMPLETED', now() - g * interval '1 minute', now()
      FROM generate_series(1, 20000) g;

      CREATE TABLE "AdminAuditLog" (
        id text PRIMARY KEY, "actorID" text NOT NULL, "actorAccountId" text, action text NOT NULL,
        "entityType" text, "entityID" text, reason text, metadata jsonb, "requestId" text,
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "AdminAuditLog_actorID_createdAt_idx" ON "AdminAuditLog"("actorID", "createdAt");
      CREATE INDEX "AdminAuditLog_entityType_entityID_createdAt_idx" ON "AdminAuditLog"("entityType", "entityID", "createdAt");
      CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"(action, "createdAt");
      CREATE INDEX "AdminAuditLog_action_trgm_idx" ON "AdminAuditLog" USING gin (action gin_trgm_ops);
      INSERT INTO "AdminAuditLog" (id, "actorID", action, "createdAt")
      SELECT md5('l' || g), 'a1', CASE WHEN g % 10 = 0 THEN 'user.ban.failed' ELSE 'user.ban' END,
        now() - g * interval '1 minute'
      FROM generate_series(1, 20000) g;
    `);
    for (const name of MIGRATIONS) {
      const migration = readFileSync(
        join(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      );
      for (const statement of statements(migration)) {
        await s.db.query(statement);
      }
    }
    await s.db.query(
      'ANALYZE "User"; ANALYZE "NotificationPushOutbox"; ANALYZE "AdminAuditLog"',
    );
  });

  afterAll(async () => {
    await s?.close();
    await capture.prisma.$disconnect();
  });

  describe('user search (phoneNumber partial index)', () => {
    const service = new AdminUserService(
      prisma,
      ...([{}, {}, {}, {}] as unknown as [never, never, never, never]),
    );

    const keywordSearch = () =>
      captureQueries(capture.queries, () =>
        service.listUsers({ page: 1, limit: 20, keyword: '13800000012' }),
      );
    const expectBitmapOr = (explained: string) => {
      expect(explained).toContain('BitmapOr');
      expect(explained).toContain('User_accountId_trgm_idx');
      expect(explained).toContain('User_nickname_trgm_idx');
      expect(explained).toContain('User_email_key');
      expect(explained).toContain('User_phoneNumber_present_idx');
      expect(explained).not.toContain('Seq Scan');
    };

    it('turns the keyword OR of the count into a BitmapOr over four indexes', async () => {
      const [, count] = await keywordSearch();
      expect(count.sql).toMatch(/COUNT\(\*\)/);
      expectBitmapOr(await plan(count.sql, count.args));
    });

    // 分页那条另有「倒着走 createdAt 索引逐行过滤」这条路;关掉普通索引扫描,只看
    // OR 本身能不能拆成 BitmapOr(10 万行以上规划器自己就会选它)。
    it('can serve the page query from the same BitmapOr', async () => {
      const [page] = await keywordSearch();
      expectBitmapOr(
        await plan(page.sql, page.args, ['SET LOCAL enable_indexscan = off']),
      );
    });

    it('cannot use BitmapOr without the phoneNumber index (control)', async () => {
      const [, count] = await keywordSearch();
      const explained = await plan(count.sql, count.args, [
        'DROP INDEX "User_phoneNumber_present_idx"',
      ]);
      expect(explained).not.toContain('BitmapOr');
      expect(explained).toContain('Seq Scan');
    });

    it('still finds the user by an exact phone number', async () => {
      const [page] = await captureQueries(capture.queries, () =>
        service.listUsers({ page: 1, limit: 20, keyword: '13800000012' }),
      );
      const { rows } = await s.db.query(page.sql, page.args);
      expect(rows.map((row: { id: string }) => row.id)).toEqual(['u12']);
    });
  });

  describe('admin list (role partial index)', () => {
    // 原实现的 Prisma 查询,作为对照组:新构造器的结果、顺序、分页、total 必须一致。
    const reference = async (search: string | undefined, page: number) => {
      const where = {
        role: 'ADMIN' as const,
        status: { not: 'DELETED' as const },
        ...(search
          ? {
              OR: [
                {
                  accountId: { contains: search, mode: 'insensitive' as const },
                },
                {
                  nickname: { contains: search, mode: 'insensitive' as const },
                },
              ],
            }
          : {}),
      };
      const [list, count] = await captureQueries(capture.queries, async () => {
        await capture.prisma.user.findMany({
          where,
          select: { id: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * 2,
          take: 2,
        });
        await capture.prisma.user.count({ where });
      });
      const ids = (await s.db.query(list.sql, list.args)).rows.map(
        (row: { id: string }) => row.id,
      );
      const total = Number(
        Object.values((await s.db.query(count.sql, count.args)).rows[0])[0],
      );
      return { ids, total };
    };

    it.each([
      [undefined, 1],
      [undefined, 2],
      [undefined, 3],
      ['ops', 1],
      ['ops', 2],
      ['OPS', 1],
      ['100%', 1],
      ['%', 1],
      ['_', 1],
      ['审核', 1],
      ['nobody', 1],
    ])(
      'matches the Prisma query for search=%p page=%p',
      async (search, page) => {
        const expected = await reference(search, page);
        const pageQuery = buildAdminListPageQuery({
          search,
          limit: 2,
          offset: (page - 1) * 2,
        });
        const countQuery = buildAdminListCountQuery({ search });
        const rows = (
          await s.db.query<{ id: string }>(pageQuery.text, pageQuery.values)
        ).rows;
        const counted = (
          await s.db.query<{ total: number }>(
            countQuery.text,
            countQuery.values,
          )
        ).rows[0];

        expect(rows.map((row) => row.id)).toEqual(expected.ids);
        expect(counted.total).toBe(expected.total);
      },
    );

    it('returns the console role and version, defaulting when there is no grant row', async () => {
      const query = buildAdminListPageQuery({ limit: 10, offset: 0 });
      const { rows } = await s.db.query(query.text, query.values);
      expect(rows).toEqual([
        {
          id: 'a2',
          accountId: 'ops_beta',
          nickname: '运营 B',
          status: 'BANNED',
          consoleRole: null,
          version: null,
        },
        {
          id: 'a1',
          accountId: 'ops_alpha',
          nickname: '运营 A',
          status: 'ACTIVE',
          consoleRole: 'SUPER_ADMIN',
          version: 3,
        },
        {
          id: 'a3',
          accountId: 'ops_100%',
          nickname: '审核_一',
          status: 'ACTIVE',
          consoleRole: 'AUDITOR',
          version: 1,
        },
        {
          id: 'a5',
          accountId: 'audit_x',
          nickname: 'Ops 大写',
          status: 'ACTIVE',
          consoleRole: null,
          version: null,
        },
      ]);
    });

    it('lets the planner pick the tiny partial index on its own, page and count', async () => {
      for (const query of [
        buildAdminListPageQuery({ search: 'ops', limit: 20, offset: 0 }),
        buildAdminListCountQuery({ search: 'ops' }),
        buildAdminListCountQuery({}),
      ]) {
        const explained = await explainPlan(s.db, query.text, query.values);
        expect(explained).toContain('User_admin_createdAt_idx');
        expect(explained).not.toContain('Seq Scan');
      }
    });
  });

  // 对照:同样的条件交给 Prisma,编译成 "role" = CAST($1::text AS "UserRole")。
  // text → 枚举走 enum_in(STABLE),规划期不折叠,部分索引的谓词证明不了 —— 这就是
  // 管理员列表改走字面量原生 SQL 的原因。
  it('cannot use the partial index through the Prisma enum-cast shape (control)', async () => {
    const [counted] = await captureQueries(capture.queries, () =>
      capture.prisma.user.count({
        where: { role: 'ADMIN', status: { not: 'DELETED' } },
      }),
    );
    expect(counted.sql).toMatch(/CAST\(\$1::text AS "UserRole"\)/);
    const explained = await plan(counted.sql, counted.args);
    expect(explained).not.toContain('User_admin_createdAt_idx');
  });

  describe('push outbox (createdAt, id) index', () => {
    const service = new ConsoleOperationsService(prisma, new ConfigService());

    it('serves the 24h status breakdown from the createdAt index', async () => {
      const queries = await captureQueries(capture.queries, () =>
        service.pushOverview(),
      );
      const groupBy = queries.find((query) => /GROUP BY/.test(query.sql));
      expect(groupBy).toBeDefined();
      const explained = await plan(groupBy!.sql, groupBy!.args);
      expect(explained).toContain('NotificationPushOutbox_createdAt_id_idx');
    });

    it.each([undefined, `${new Date().toISOString()}|${'f'.repeat(64)}`])(
      'walks the push list in index order without a sort (cursor=%p)',
      async (cursor) => {
        const [list] = await captureQueries(capture.queries, () =>
          service.pushes({ limit: 20, days: 30, cursor }),
        );
        const explained = await plan(list.sql, list.args);
        expect(explained).toContain('NotificationPushOutbox_createdAt_id_idx');
        expect(explained).not.toContain('"Node Type":"Sort"');
      },
    );
  });

  describe('admin audit log (createdAt, id) index', () => {
    it('walks the default audit list in index order without a sort', async () => {
      const service = new AdminAuditQueryService(prisma);
      const [list] = await captureQueries(capture.queries, () =>
        service.list({ page: 1, limit: 20 }),
      );
      const explained = await plan(list.sql, list.args);
      expect(explained).toContain('AdminAuditLog_createdAt_id_idx');
      expect(explained).not.toContain('"Node Type":"Sort"');
    });

    it('serves the diagnostics page from the same index', async () => {
      const service = new ConsoleInsightsService(prisma, {} as never);
      const [list] = await captureQueries(capture.queries, () =>
        service.diagnostics({ limit: 20, days: 30 }),
      );
      const explained = await plan(list.sql, list.args);
      expect(explained).toContain('AdminAuditLog_createdAt_id_idx');
      expect(explained).not.toContain('"Node Type":"Sort"');
    });
  });
});
