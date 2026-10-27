import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { FriendService } from 'src/friend/friend.service';
import type { PrismaService } from 'src/prisma/prisma.service';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * Friend / FriendTagOnFriend 索引迁移(20261026000200 ~ 0240)在真 PostgreSQL 上的效果:
 * - 配对查找 (a,b) OR (b,a) 走复合索引。只有单列索引时,OR 的每一支只能用较少的那一侧
 *   取行再逐行比对另一侧;两个人都是好友多的账号时,每次查找要读上千行;
 * - 两个单列索引删掉后,好友列表(userID = $1 OR friendID = $1)和删用户时的外键级联
 *   靠复合索引的前导列,仍不退回全表扫描;
 * - 删好友 / 删标签时对 FriendTagOnFriend 的外键级联走新的 friendID / tagID 索引。
 *
 * Friend 的查询是 FriendService 用假 adapter 现场编译出的 SQL(prisma-sql-capture);
 * 外键级联的语句形状照 PostgreSQL ri_triggers.c 生成的
 *   DELETE FROM ONLY <表> WHERE $1 OPERATOR(pg_catalog.=) <外键列>
 */
const FRIEND_INDEX_MIGRATIONS = [
  '20261026000200_friend_pair_indexes',
  '20261026000230_drop_friend_user_idx',
  '20261026000240_drop_friend_friend_idx',
];
const TAG_LINK_INDEX_MIGRATION = '20261026000210_friend_tag_link_fk_indexes';

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

const migrationStatements = (name: string): string[] =>
  statements(
    readFileSync(
      join(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
      'utf8',
    ),
  );

const cascadeDelete = (table: string, column: string) =>
  `DELETE FROM ONLY "${table}" WHERE $1 OPERATOR(pg_catalog.=) "${column}"`;

describePostgres('friend indexes (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const capture = capturePrisma();
  const service = new FriendService(
    capture.prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: () => null } as unknown as ConfigService,
  );

  /** 只读的 EXPLAIN 放进事务,DELETE 的计划也不会真删。 */
  const plan = async (sql: string, values: unknown[]) => {
    await s.db.query('BEGIN');
    try {
      return await explainPlan(s.db, sql, values);
    } finally {
      await s.db.query('ROLLBACK');
    }
  };
  /** 实际执行一次,返回读到的数据页数(共享缓冲命中 + 读盘)。 */
  const blocksTouched = async (sql: string, values: unknown[]) => {
    const result = await s.db.query<{
      'QUERY PLAN': [{ Plan: Record<string, number> }];
    }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
    const top = result.rows[0]['QUERY PLAN'][0].Plan;
    return top['Shared Hit Blocks'] + top['Shared Read Blocks'];
  };
  const indexNames = async (table: string) => {
    const { rows } = await s.db.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
      [s.schema, table],
    );
    return rows.map((row) => row.indexname).sort();
  };
  const runMigration = async (name: string) => {
    // CONCURRENTLY 不能进多语句的隐式事务:逐条执行,和 Prisma 部署时一样。
    for (const statement of migrationStatements(name)) {
      await s.db.query(statement);
    }
  };

  // 迁移前后的计划:beforeAll 里各记一份,用例只做断言,不依赖用例顺序。
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  const blocks = { before: 0, after: 0 };
  let pairLookup: { sql: string; args: unknown[] };
  let friendList: { sql: string; args: unknown[] };

  beforeAll(async () => {
    s = await openIsolatedSchema('friend_idx');
    await s.db.query(`
      CREATE TYPE "FriendState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
      CREATE TYPE "FriendPermission" AS ENUM ('FULL', 'CHAT_ONLY');
      CREATE TABLE "Friend" (
        id text PRIMARY KEY, "userID" text NOT NULL, "friendID" text NOT NULL,
        state "FriendState" NOT NULL DEFAULT 'PENDING', message text,
        "pendingRemarkBySender" text, "remarkA" text, "remarkB" text,
        "pendingDescriptionBySender" text, "descriptionA" text, "descriptionB" text,
        "pendingPhotosBySender" text[] NOT NULL DEFAULT '{}',
        "photosA" text[] NOT NULL DEFAULT '{}', "photosB" text[] NOT NULL DEFAULT '{}',
        "pendingPermissionBySender" "FriendPermission",
        "permissionA" "FriendPermission" NOT NULL DEFAULT 'FULL',
        "permissionB" "FriendPermission" NOT NULL DEFAULT 'FULL',
        "createdAt" timestamp(3) NOT NULL DEFAULT now(),
        "updatedAt" timestamp(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX "Friend_userID_idx" ON "Friend"("userID");
      CREATE INDEX "Friend_friendID_idx" ON "Friend"("friendID");
      CREATE TABLE "FriendTagOnFriend" (
        id text PRIMARY KEY, "ownerID" text NOT NULL, "tagID" text NOT NULL,
        "friendID" text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "FriendTagOnFriend_ownerID_tagID_friendID_key"
        ON "FriendTagOnFriend"("ownerID", "tagID", "friendID");
      CREATE INDEX "FriendTagOnFriend_ownerID_friendID_idx"
        ON "FriendTagOnFriend"("ownerID", "friendID");

      -- 两个「大 V」:各有 3000 条关系(一半作为 userID、一半作为 friendID),
      -- 另有 60000 条散户关系。
      INSERT INTO "Friend" (id, "userID", "friendID", state)
      SELECT 'hub-a-' || g,
             CASE WHEN g % 2 = 0 THEN 'hub' ELSE 'fan' || g END,
             CASE WHEN g % 2 = 0 THEN 'fan' || g ELSE 'hub' END,
             'ACCEPTED'
      FROM generate_series(1, 3000) g;
      INSERT INTO "Friend" (id, "userID", "friendID", state)
      SELECT 'hub-b-' || g,
             CASE WHEN g % 2 = 0 THEN 'star' ELSE 'fan' || g END,
             CASE WHEN g % 2 = 0 THEN 'fan' || g ELSE 'star' END,
             'ACCEPTED'
      FROM generate_series(1, 3000) g;
      INSERT INTO "Friend" (id, "userID", "friendID", state)
      VALUES ('hub-star', 'hub', 'star', 'ACCEPTED');
      INSERT INTO "Friend" (id, "userID", "friendID", state)
      SELECT 'f-' || g, 'u' || (g % 20000), 'u' || ((g * 7 + 1) % 20000),
             CASE WHEN g % 5 = 0 THEN 'PENDING' ELSE 'ACCEPTED' END::"FriendState"
      FROM generate_series(1, 60000) g;

      INSERT INTO "FriendTagOnFriend" (id, "ownerID", "tagID", "friendID")
      SELECT 'l-' || g, 'u' || (g % 20000), 'tag-' || (g % 3000), 'f-' || g
      FROM generate_series(1, 60000) g;
      ANALYZE "Friend";
      ANALYZE "FriendTagOnFriend";
    `);

    // 两个大 V 之间的配对查找:任一侧都有上千条关系。
    [pairLookup] = await captureQueries(capture.queries, () =>
      service.getFriendSettings('star', 'hub'),
    );
    [friendList] = await captureQueries(capture.queries, () =>
      service.listFriends('hub'),
    );

    before.pair = await plan(pairLookup.sql, pairLookup.args);
    blocks.before = await blocksTouched(pairLookup.sql, pairLookup.args);
    before.tagLinkByFriend = await plan(
      cascadeDelete('FriendTagOnFriend', 'friendID'),
      ['f-42'],
    );
    before.tagLinkByTag = await plan(
      cascadeDelete('FriendTagOnFriend', 'tagID'),
      ['tag-42'],
    );

    for (const name of FRIEND_INDEX_MIGRATIONS) await runMigration(name);
    await runMigration(TAG_LINK_INDEX_MIGRATION);
    await s.db.query('ANALYZE "Friend"');
    await s.db.query('ANALYZE "FriendTagOnFriend"');

    after.pair = await plan(pairLookup.sql, pairLookup.args);
    blocks.after = await blocksTouched(pairLookup.sql, pairLookup.args);
    after.friendList = await plan(friendList.sql, friendList.args);
    after.friendCascadeByUser = await plan(cascadeDelete('Friend', 'userID'), [
      'hub',
    ]);
    after.friendCascadeByFriend = await plan(
      cascadeDelete('Friend', 'friendID'),
      ['hub'],
    );
    after.tagLinkByFriend = await plan(
      cascadeDelete('FriendTagOnFriend', 'friendID'),
      ['f-42'],
    );
    after.tagLinkByTag = await plan(
      cascadeDelete('FriendTagOnFriend', 'tagID'),
      ['tag-42'],
    );
  });

  afterAll(async () => {
    await s?.close();
  });

  it('captures the pair lookup and the friend list from FriendService', () => {
    expect(pairLookup.sql).toMatch(
      /"Friend"\."userID" = \$1 AND "Friend"\."friendID" = \$2\) OR \("Friend"\."userID" = \$3 AND "Friend"\."friendID" = \$4/,
    );
    expect(friendList.sql).toMatch(
      /"Friend"\."userID" = \$1 OR "Friend"\."friendID" = \$2/,
    );
  });

  it('keeps only the two composite indexes on Friend', async () => {
    expect(await indexNames('Friend')).toEqual([
      'Friend_friendID_userID_idx',
      'Friend_pkey',
      'Friend_userID_friendID_idx',
    ]);
  });

  it('probes the pair through a composite index instead of filtering one side', () => {
    // 迁移前:要么按一侧(单列索引)取出大 V 的上千条关系再逐行比对另一侧,
    // 要么干脆顺序扫描(两边都是大 V 时规划器常这么选)。
    expect(before.pair).toMatch(/Seq Scan|Friend_(userID|friendID)_idx"/);
    expect(after.pair).toMatch(/Friend_(userID_friendID|friendID_userID)_idx/);
    expect(after.pair).not.toMatch(/Friend_(userID|friendID)_idx"/);
    expect(after.pair).not.toContain('Seq Scan');
    // 实际读页数:两次精确探测 vs 扫两个大 V 的关系行。
    expect(blocks.after * 5).toBeLessThan(blocks.before);
  });

  it('still finds the pair row in both directions', async () => {
    const { rows } = await s.db.query<{ id: string }>(
      pairLookup.sql,
      pairLookup.args,
    );
    expect(rows.map((row) => row.id)).toEqual(['hub-star']);

    const [reverse] = await captureQueries(capture.queries, () =>
      service.getFriendSettings('fan41', 'hub'),
    );
    const reversed = await s.db.query<{ id: string }>(
      reverse.sql,
      reverse.args,
    );
    expect(reversed.rows.map((row) => row.id)).toEqual(['hub-a-41']);
  });

  it('serves the friend list and user-delete cascades from the composite prefixes', () => {
    expect(after.friendList).toContain('Friend_userID_friendID_idx');
    expect(after.friendList).toContain('Friend_friendID_userID_idx');
    expect(after.friendList).not.toContain('Seq Scan');
    expect(after.friendCascadeByUser).toContain('Friend_userID_friendID_idx');
    expect(after.friendCascadeByUser).not.toContain('Seq Scan');
    expect(after.friendCascadeByFriend).toContain('Friend_friendID_userID_idx');
    expect(after.friendCascadeByFriend).not.toContain('Seq Scan');
  });

  it('turns the tag-link cascades from full scans into index probes', () => {
    expect(before.tagLinkByFriend).toContain('Seq Scan');
    expect(before.tagLinkByTag).toContain('Seq Scan');
    expect(after.tagLinkByFriend).toContain('FriendTagOnFriend_friendID_idx');
    expect(after.tagLinkByFriend).not.toContain('Seq Scan');
    expect(after.tagLinkByTag).toContain('FriendTagOnFriend_tagID_idx');
    expect(after.tagLinkByTag).not.toContain('Seq Scan');
  });
});
