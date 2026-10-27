import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * 迁移 20261026000510 的两条部分索引在真 PostgreSQL 上确实被用到：
 * - 解散圈子按 circleID 删佩戴图标（Prisma deleteMany，离线编译核对过形状）；
 * - 删旧 IconAsset 时，Circle.currentIconAssetID 外键（ON DELETE SET NULL）的引用完整性
 *   触发器按它找圈子行。触发器内部的计划 EXPLAIN 看不到，用本事务的索引扫描计数
 *   （pg_stat_get_xact_numscans）验证它真的走了索引。
 */
describePostgres('circle icon reference indexes (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const capture = capturePrisma();

  const MIGRATION =
    'prisma/migrations/20261026000510_circle_icon_reference_indexes/migration.sql';

  /** 本事务里对该索引做过的扫描次数（还没刷进累计统计视图的那部分）。 */
  const indexScansInTransaction = async (index: string) => {
    const { rows } = await s.db.query<{ scans: string }>(
      `SELECT pg_stat_get_xact_numscans(format('%I.%I', $1::text, $2::text)::regclass) AS scans`,
      [s.schema, index],
    );
    return Number(rows[0].scans);
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('circle_icon_refs');
    await s.db.query(`
      CREATE TABLE "IconAsset" (id text PRIMARY KEY, "circleID" text);
      CREATE TABLE "Circle" (
        id text PRIMARY KEY,
        "memberCount" int NOT NULL DEFAULT 0,
        "currentIconAssetID" text REFERENCES "IconAsset"(id)
          ON DELETE SET NULL ON UPDATE CASCADE
      );
      CREATE TABLE "UserDisplayIcon" (
        id text PRIMARY KEY,
        "userID" text NOT NULL,
        "circleID" text REFERENCES "Circle"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        "sortOrder" int NOT NULL
      );
      -- 线上已有的两条，都以 userID 打头。
      CREATE UNIQUE INDEX "UserDisplayIcon_userID_circleID_key"
        ON "UserDisplayIcon" ("userID", "circleID");
      CREATE INDEX "UserDisplayIcon_userID_sortOrder_idx"
        ON "UserDisplayIcon" ("userID", "sortOrder");
    `);
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

    await s.db.query(`
      INSERT INTO "IconAsset" (id, "circleID")
      SELECT 'asset-' || g, 'circle-' || g FROM generate_series(1, 3000) g;
      INSERT INTO "Circle" (id, "currentIconAssetID")
      SELECT 'circle-' || g, CASE WHEN g % 10 = 0 THEN 'asset-' || g END
      FROM generate_series(1, 3000) g;
      INSERT INTO "UserDisplayIcon" (id, "userID", "circleID", "sortOrder")
      SELECT 'icon-' || g, 'user-' || g,
             CASE WHEN g % 4 = 0 THEN 'circle-' || (g % 3000 + 1) END, g % 5
      FROM generate_series(1, 6000) g;
      ANALYZE "IconAsset"; ANALYZE "Circle"; ANALYZE "UserDisplayIcon";
    `);
  });

  afterAll(async () => {
    await s?.close();
  });

  it('deletes a dissolved circle’s worn icons through the circleID index', async () => {
    // 解散圈子（circle.service.ts dissolveCircle）里的同一个 Prisma 调用，现场编译成 SQL。
    const [compiled] = await captureQueries(capture.queries, () =>
      capture.prisma.userDisplayIcon.deleteMany({
        where: { circleID: 'circle-5' },
      }),
    );
    expect(compiled.args).toEqual(['circle-5']);
    const dissolve = compiled.sql;

    await s.db.query('SET enable_seqscan = off');
    try {
      expect(await explainPlan(s.db, dissolve, ['circle-5'])).toContain(
        'UserDisplayIcon_circleID_present_idx',
      );
    } finally {
      await s.db.query('RESET enable_seqscan');
    }

    await s.db.query('BEGIN');
    try {
      const { rowCount } = await s.db.query(dissolve, ['circle-5']);
      expect(rowCount).toBeGreaterThan(0);
      const { rows } = await s.db.query(
        `SELECT count(*)::int AS left FROM "UserDisplayIcon" WHERE "circleID" = 'circle-5'`,
      );
      expect(rows[0].left).toBe(0);
    } finally {
      await s.db.query('ROLLBACK');
    }
  });

  it('lets the currentIconAssetID foreign key action find circles by index', async () => {
    // 外键动作的 SPI 计划在本会话第一次触发时生成并缓存；先关掉顺序扫描，让小表
    // 也按「有索引就用索引」出计划。没有这条索引时只能顺序扫描（计数恒为 0）。
    await s.db.query('SET enable_seqscan = off');
    await s.db.query('BEGIN');
    try {
      const before = await indexScansInTransaction(
        'Circle_currentIconAssetID_present_idx',
      );
      // 等价于 uploadIcon 里 iconAsset.deleteMany 删掉旧图标。
      await s.db.query(`DELETE FROM "IconAsset" WHERE id = 'asset-20'`);
      const after = await indexScansInTransaction(
        'Circle_currentIconAssetID_present_idx',
      );
      expect(after).toBeGreaterThan(before);

      const { rows } = await s.db.query(
        `SELECT "currentIconAssetID" FROM "Circle" WHERE id = 'circle-20'`,
      );
      expect(rows[0].currentIconAssetID).toBeNull();
    } finally {
      await s.db.query('ROLLBACK');
      await s.db.query('RESET enable_seqscan');
    }
  });

  it('keeps a generic (cached) plan on the partial index for the FK lookup', async () => {
    // 外键触发器的计划是会话级缓存的通用计划，参数值在规划期不可见。严格运算符 =
    // 让规划器照样推出 IS NOT NULL，部分索引仍可用。
    await s.db.query('SET enable_seqscan = off');
    await s.db.query('SET plan_cache_mode = force_generic_plan');
    try {
      await s.db.query(`PREPARE fk_probe(text) AS
        UPDATE ONLY "Circle" SET "currentIconAssetID" = NULL
        WHERE $1 OPERATOR(pg_catalog.=) "currentIconAssetID"`);
      const { rows } = await s.db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN EXECUTE fk_probe('asset-30')`,
      );
      expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'Circle_currentIconAssetID_present_idx',
      );
    } finally {
      await s.db.query('DEALLOCATE ALL');
      await s.db.query('RESET plan_cache_mode');
      await s.db.query('RESET enable_seqscan');
    }
  });
});
