import type { Prisma } from 'src/generated/prisma';
import {
  buildCircleSearchCountQuery,
  buildCircleSearchPageQuery,
} from 'src/admin-community/admin-circle-search.query';
import {
  buildCampaignSearchCountQuery,
  buildCampaignSearchPageQuery,
  buildReferralSearchCountQuery,
  buildReferralSearchPageQuery,
} from 'src/admin-operations/admin-invite-search.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * 管理台三处关键词搜索改成「各个可索引的分支分别取 id 再 UNION」之后,与原 Prisma
 * 查询(OR 里跨 LEFT JOIN 的关系条件,规划器只能整表扫)逐页对照:集合、排序、分页、
 * total 都必须一致;再用 EXPLAIN 确认新查询每个分支都走了索引。
 *
 * 对照组是原实现的 where,由 Prisma 现场编译(prisma-sql-capture)后在同一份数据上执行。
 */
const contains = (search: string) => ({
  contains: search,
  mode: 'insensitive' as const,
});

const SEARCHES = [
  'alice',
  'ALICE',
  'ops',
  '1',
  '12',
  '%',
  '_',
  'circle 1',
  '昵称12',
  'grp-3',
  'code1',
  'nomatch',
];

describePostgres('admin search UNION rewrite (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const capture = capturePrisma();

  const run = async <T extends Record<string, unknown>>(query: Prisma.Sql) =>
    (await s.db.query<T>(query.text, query.values)).rows;

  // 执行一组 Prisma 编译出的「分页 + 计数」,返回 id 序列和 total。
  const reference = async (
    page: () => Promise<unknown>,
    count: () => Promise<unknown>,
  ) => {
    const [list] = await captureQueries(capture.queries, page);
    const [counted] = await captureQueries(capture.queries, count);
    const ids = (
      await s.db.query<{ id: string }>(list.sql, list.args)
    ).rows.map((row) => row.id);
    const total = Number(
      Object.values(
        (await s.db.query(counted.sql, counted.args)).rows[0] as object,
      )[0],
    );
    return { ids, total };
  };

  // 表小(几千行),规划器宁可整条主键索引扫一遍再过滤。关掉顺序扫描和普通索引扫描,
  // 只剩 bitmap 路径:每个分支能不能用上 trigram 索引就一目了然(几十万行时规划器
  // 自己会这么选)。原 Prisma 查询在同样设置下只能退回顺序扫描,见最后的对照用例。
  const indexPlan = async (sql: string, values: unknown[]) => {
    await s.db.query('BEGIN');
    try {
      await s.db.query('SET LOCAL enable_seqscan = off');
      await s.db.query('SET LOCAL enable_indexscan = off');
      return await explainPlan(s.db, sql, values);
    } finally {
      await s.db.query('ROLLBACK');
    }
  };
  const builtPlan = (query: Prisma.Sql) => indexPlan(query.text, query.values);

  beforeAll(async () => {
    s = await openIsolatedSchema('admin_search_union');
    await s.db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await s.db.query(`
      CREATE TYPE "CircleAdminState" AS ENUM ('ACTIVE', 'DISABLING', 'DISABLED', 'RESTORING', 'SYNC_FAILED', 'DISMISSED');
      CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REWARDED', 'CAPPED', 'REJECTED', 'EXPIRED');
      CREATE TABLE "User" (id text PRIMARY KEY, "accountId" text NOT NULL, nickname text NOT NULL);
      CREATE UNIQUE INDEX "User_accountId_key" ON "User"("accountId");
      CREATE INDEX "User_accountId_trgm_idx" ON "User" USING gin ("accountId" gin_trgm_ops);
      CREATE INDEX "User_nickname_trgm_idx" ON "User" USING gin (nickname gin_trgm_ops);

      CREATE TABLE "Circle" (
        id text PRIMARY KEY, name text NOT NULL, "groupID" text UNIQUE, "ownerID" text NOT NULL,
        "adminState" "CircleAdminState" NOT NULL DEFAULT 'ACTIVE', "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "Circle_ownerID_idx" ON "Circle"("ownerID");
      CREATE INDEX "Circle_adminState_createdAt_idx" ON "Circle"("adminState", "createdAt");
      CREATE INDEX "Circle_id_trgm_idx" ON "Circle" USING gin (id gin_trgm_ops);
      CREATE INDEX "Circle_name_trgm_idx" ON "Circle" USING gin (name gin_trgm_ops);
      CREATE INDEX "Circle_groupID_trgm_idx" ON "Circle" USING gin ("groupID" gin_trgm_ops);

      CREATE TABLE "CampaignInvite" (
        id text PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, "ownerUserID" text NOT NULL,
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "CampaignInvite_ownerUserID_createdAt_idx" ON "CampaignInvite"("ownerUserID", "createdAt");
      CREATE INDEX "CampaignInvite_code_trgm_idx" ON "CampaignInvite" USING gin (code gin_trgm_ops);
      CREATE INDEX "CampaignInvite_name_trgm_idx" ON "CampaignInvite" USING gin (name gin_trgm_ops);

      CREATE TABLE "CampaignInviteUse" (id text PRIMARY KEY, "campaignID" text NOT NULL, "userID" text NOT NULL UNIQUE);
      CREATE INDEX "CampaignInviteUse_campaignID_idx" ON "CampaignInviteUse"("campaignID");

      CREATE TABLE "Referral" (
        id text PRIMARY KEY, "inviterID" text NOT NULL, "inviteeID" text NOT NULL UNIQUE,
        status "ReferralStatus" NOT NULL DEFAULT 'PENDING', "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "Referral_inviterID_createdAt_idx" ON "Referral"("inviterID", "createdAt");

      INSERT INTO "User" (id, "accountId", nickname)
      SELECT 'u' || g, 'user' || g, '昵称' || g FROM generate_series(1, 3000) g;
      INSERT INTO "User" (id, "accountId", nickname) VALUES
        ('alice', 'alice_ops', 'Alice'), ('bob', 'bob', 'OPS 组 100%'), ('carol', 'carol_x', '普通_用户');

      -- createdAt 每三行相同:分页必须靠 id 兜底;groupID 有空有值。
      INSERT INTO "Circle" (id, name, "groupID", "ownerID", "adminState", "createdAt")
      SELECT md5('c' || g), 'circle ' || g,
        CASE WHEN g % 2 = 0 THEN 'grp-' || g END,
        CASE WHEN g % 97 = 0 THEN 'alice' WHEN g % 89 = 0 THEN 'bob' ELSE 'u' || (g % 3000 + 1) END,
        CASE WHEN g % 5 = 0 THEN 'DISABLED'::"CircleAdminState" ELSE 'ACTIVE' END,
        timestamp '2026-01-01' + (g / 3) * interval '1 minute'
      FROM generate_series(1, 2000) g;
      INSERT INTO "Circle" (id, name, "groupID", "ownerID", "createdAt") VALUES
        ('circle-ops', 'Ops 交流', NULL, 'carol', '2026-06-01'),
        ('circle-pct', '100% 纯享', 'grp-pct', 'u7', '2026-06-01');

      INSERT INTO "CampaignInvite" (id, code, name, "ownerUserID", "createdAt")
      SELECT md5('ci' || g), 'CODE' || g, 'campaign ' || g,
        CASE WHEN g % 13 = 0 THEN 'alice' ELSE 'u' || g END,
        timestamp '2026-02-01' + (g / 2) * interval '1 hour'
      FROM generate_series(1, 400) g;

      INSERT INTO "Referral" (id, "inviterID", "inviteeID", status, "createdAt")
      SELECT md5('r' || g),
        CASE WHEN g % 11 = 0 THEN 'alice' WHEN g % 7 = 0 THEN 'bob' ELSE 'u' || (g % 500 + 1) END,
        'u' || g,
        CASE WHEN g % 3 = 0 THEN 'REWARDED'::"ReferralStatus" ELSE 'PENDING' END,
        timestamp '2026-03-01' + (g / 4) * interval '1 minute'
      FROM generate_series(1, 2500) g;
      INSERT INTO "CampaignInviteUse" (id, "campaignID", "userID")
      SELECT 'use' || g, md5('ci' || (g % 3 + 1)), 'u' || g FROM generate_series(1, 2500) g WHERE g % 2 = 0;
    `);
    await s.db.query(
      'ANALYZE "User"; ANALYZE "Circle"; ANALYZE "CampaignInvite"; ANALYZE "Referral"; ANALYZE "CampaignInviteUse"',
    );
  });

  afterAll(async () => {
    await s?.close();
    await capture.prisma.$disconnect();
  });

  describe('circles (owner relation in the OR)', () => {
    const cases = SEARCHES.flatMap((search) =>
      [undefined, 'DISABLED' as const].flatMap((status) =>
        [1, 2, 3].map((page) => [search, status, page] as const),
      ),
    );

    it.each(cases)(
      'matches the Prisma query for search=%p status=%p page=%p',
      async (search, status, page) => {
        const limit = 7;
        const where: Prisma.CircleWhereInput = {
          ...(status ? { adminState: status } : {}),
          OR: [
            { id: contains(search) },
            { name: contains(search) },
            { groupID: contains(search) },
            {
              owner: {
                is: {
                  OR: [
                    { accountId: contains(search) },
                    { nickname: contains(search) },
                  ],
                },
              },
            },
          ],
        };
        const expected = await reference(
          () =>
            capture.prisma.circle.findMany({
              where,
              select: { id: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: (page - 1) * limit,
              take: limit,
            }),
          () => capture.prisma.circle.count({ where }),
        );

        const ids = (
          await run<{ id: string }>(
            buildCircleSearchPageQuery({
              search,
              status,
              limit,
              offset: (page - 1) * limit,
            }),
          )
        ).map((row) => row.id);
        const [{ total }] = await run<{ total: number }>(
          buildCircleSearchCountQuery({ search, status }),
        );

        expect(ids).toEqual(expected.ids);
        expect(total).toBe(expected.total);
      },
    );

    it('reaches every branch through an index', async () => {
      for (const query of [
        buildCircleSearchPageQuery({ search: 'alice', limit: 20, offset: 0 }),
        buildCircleSearchCountQuery({ search: 'alice', status: 'DISABLED' }),
      ]) {
        const explained = await builtPlan(query);
        for (const index of [
          'Circle_id_trgm_idx',
          'Circle_name_trgm_idx',
          'Circle_groupID_trgm_idx',
          'User_accountId_trgm_idx',
          'User_nickname_trgm_idx',
        ])
          expect(explained).toContain(index);
        expect(explained).not.toContain('Seq Scan');
      }
    });
  });

  describe('campaign invites (owner relation in the OR)', () => {
    const cases = SEARCHES.flatMap((search) =>
      [1, 2, 3].map((page) => [search, page] as const),
    );

    it.each(cases)(
      'matches the Prisma query for search=%p page=%p',
      async (search, page) => {
        const limit = 7;
        const where: Prisma.CampaignInviteWhereInput = {
          OR: [
            { code: contains(search) },
            { name: contains(search) },
            { owner: { accountId: contains(search) } },
          ],
        };
        const expected = await reference(
          () =>
            capture.prisma.campaignInvite.findMany({
              where,
              select: { id: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: (page - 1) * limit,
              take: limit,
            }),
          () => capture.prisma.campaignInvite.count({ where }),
        );

        const ids = (
          await run<{ id: string }>(
            buildCampaignSearchPageQuery({
              search,
              limit,
              offset: (page - 1) * limit,
            }),
          )
        ).map((row) => row.id);
        const [{ total }] = await run<{ total: number }>(
          buildCampaignSearchCountQuery({ search }),
        );

        expect(ids).toEqual(expected.ids);
        expect(total).toBe(expected.total);
      },
    );

    it('reaches every branch through an index', async () => {
      const explained = await builtPlan(
        buildCampaignSearchCountQuery({ search: 'alice' }),
      );
      for (const index of [
        'CampaignInvite_code_trgm_idx',
        'CampaignInvite_name_trgm_idx',
        'User_accountId_trgm_idx',
      ])
        expect(explained).toContain(index);
      expect(explained).not.toContain('Seq Scan');
    });
  });

  describe('referrals (inviter / invitee relations in the OR)', () => {
    const cases = SEARCHES.flatMap((search) =>
      [
        { status: undefined, campaignID: undefined },
        { status: 'REWARDED' as const, campaignID: undefined },
        { status: undefined, campaignID: 'md5:2' },
      ].flatMap((filters) =>
        [1, 2].map((page) => [search, filters, page] as const),
      ),
    );
    let campaignIDs: Record<string, string>;

    beforeAll(async () => {
      const { rows } = await s.db.query<{ id: string }>(
        `SELECT md5('ci2') AS id`,
      );
      campaignIDs = { 'md5:2': rows[0].id };
    });

    it.each(cases)(
      'matches the Prisma query for search=%p filters=%p page=%p',
      async (search, filters, page) => {
        const limit = 7;
        const campaignID = filters.campaignID
          ? campaignIDs[filters.campaignID]
          : undefined;
        const where: Prisma.ReferralWhereInput = {
          ...(filters.status ? { status: filters.status } : {}),
          ...(campaignID
            ? { invitee: { campaignInviteUse: { campaignID } } }
            : {}),
          OR: [
            { inviter: { accountId: contains(search) } },
            { invitee: { accountId: contains(search) } },
          ],
        };
        const expected = await reference(
          () =>
            capture.prisma.referral.findMany({
              where,
              select: { id: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: (page - 1) * limit,
              take: limit,
            }),
          () => capture.prisma.referral.count({ where }),
        );

        const input = { search, status: filters.status, campaignID };
        const ids = (
          await run<{ id: string }>(
            buildReferralSearchPageQuery({
              ...input,
              limit,
              offset: (page - 1) * limit,
            }),
          )
        ).map((row) => row.id);
        const [{ total }] = await run<{ total: number }>(
          buildReferralSearchCountQuery(input),
        );

        expect(ids).toEqual(expected.ids);
        expect(total).toBe(expected.total);
      },
    );

    it('reaches both relation branches through the user trigram index', async () => {
      const explained = await builtPlan(
        buildReferralSearchCountQuery({ search: 'alice' }),
      );
      expect(explained).toContain('User_accountId_trgm_idx');
      expect(explained).not.toContain('Seq Scan');
    });
  });

  // 对照:原 Prisma 查询(OR 跨 LEFT JOIN)在同样设置下用不上任何 trigram 索引,
  // 只能整表扫(Circle 全量走一遍,逐行回查圈主)。
  it('shows the original circle query cannot use the trigram indexes (control)', async () => {
    const [counted] = await captureQueries(capture.queries, () =>
      capture.prisma.circle.count({
        where: {
          OR: [
            { name: contains('alice') },
            { owner: { is: { accountId: contains('alice') } } },
          ],
        },
      }),
    );
    const explained = await indexPlan(counted.sql, counted.args);
    expect(explained).not.toContain('trgm_idx');
    // 只能选一条被禁用的整表路径(顺序扫描或整条索引扫描),代价里带着 disable_cost。
    const [{ Plan }] = JSON.parse(explained) as [
      { Plan: { 'Total Cost': number } },
    ];
    expect(Plan['Total Cost']).toBeGreaterThanOrEqual(1e10);
  });
});
