import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import {
  describePostgres,
  openIsolatedSchema,
  type IsolatedSchema,
} from './pg-test-db';

/**
 * 运营台事件量收口(20261025000100_console_message_event、
 * 20261025000150_console_session_event)的真库回归。
 *
 * 旧触发器每条聊天消息、每次 refresh token 续签各写一行 ConsoleEvent,而且就在
 * 发送事务里。这里先按旧迁移原文装上旧函数和旧触发器,再整份执行新迁移,断言
 * 「每人每 5 分钟一条」「只记新登录」以及并发下消息写入不受影响。
 */
const migrationsDir = resolve(process.cwd(), 'prisma/migrations');
const readMigration = (name: string): string =>
  readFileSync(resolve(migrationsDir, name, 'migration.sql'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

function pick(sql: string, pattern: RegExp): string {
  const match = pattern.exec(sql);
  if (!match) throw new Error(`migration fragment not found: ${pattern}`);
  return match[0];
}

/** 旧迁移里与这两条触发器相关的原文:表结构、索引、默认值、函数、触发器。 */
function legacyConsoleSql(): string[] {
  const console = readMigration('20261017010000_operations_console');
  const timeline = readMigration('20261017012000_console_business_timeline');
  const utc = readMigration('20261017013000_console_utc_timestamps');
  return [
    pick(console, /^CREATE TABLE "ConsoleEvent" .*;$/m),
    ...(console.match(/^CREATE INDEX "ConsoleEvent_.*;$/gm) ?? []),
    pick(utc, /^ALTER TABLE "ConsoleEvent" ALTER COLUMN "createdAt" .*;$/m),
    pick(console, /CREATE FUNCTION circle_console_event\(\)[\s\S]*?END \$\$;/),
    pick(console, /^CREATE TRIGGER console_message .*;$/m),
    pick(
      timeline,
      /CREATE OR REPLACE FUNCTION circle_console_event\(\)[\s\S]*?END \$\$;/,
    ),
    pick(timeline, /^CREATE TRIGGER console_session .*;$/m),
  ];
}

type EventRow = {
  id: string;
  userID: string;
  name: string;
  source: string;
  entityType: string | null;
  entityID: string | null;
  /** 文本形式:node-pg 会把无时区 timestamp 按本机时区解析,断言不能依赖它。 */
  at: string;
};

describePostgres('console event volume triggers', () => {
  let isolated: IsolatedSchema;
  let db: Client;

  beforeAll(async () => {
    isolated = await openIsolatedSchema('console_event_volume');
    db = isolated.db;
    // 只建触发器和断言用得到的列;content 留着,证明新函数不再碰整行。
    await db.query(`
      CREATE TABLE "User" (id TEXT PRIMARY KEY);
      CREATE TABLE "ChatMessage" (
        id TEXT PRIMARY KEY,
        "senderID" TEXT,
        content JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "RefreshToken" (
        id TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
        "familyId" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX "RefreshToken_userId_familyId_idx" ON "RefreshToken"("userId", "familyId");
    `);
    for (const statement of legacyConsoleSql()) await db.query(statement);
    await db.query(readMigration('20261025000100_console_message_event'));
    await db.query(readMigration('20261025000150_console_session_event'));
  });

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await db.query('SET TIME ZONE UTC');
    await db.query(
      'TRUNCATE "ConsoleEvent", "ChatMessage", "RefreshToken", "User" CASCADE',
    );
    await db.query(`INSERT INTO "User" (id) VALUES ('u1'), ('u2')`);
  });

  const insertMessage = (
    client: Client,
    id: string,
    senderID: string | null,
    createdAt: string,
  ) =>
    client.query(
      `INSERT INTO "ChatMessage" (id, "senderID", content, "createdAt") VALUES ($1, $2, $3, $4::timestamp)`,
      [id, senderID, { ciphertext: 'x'.repeat(4096) }, createdAt],
    );

  const events = async (name: string): Promise<EventRow[]> =>
    (
      await db.query<EventRow>(
        `SELECT id, "userID", name, source, "entityType", "entityID",
                to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS at
         FROM "ConsoleEvent" WHERE name = $1 ORDER BY "createdAt", "entityID"`,
        [name],
      )
    ).rows;

  it('keeps the trigger name and WHEN clause while swapping in the dedicated function', async () => {
    const { rows } = await db.query<{ tgname: string; def: string }>(`
      SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN ('"ChatMessage"'::regclass, '"RefreshToken"'::regclass)
      ORDER BY tgname`);
    expect(rows.map((row) => row.tgname)).toEqual([
      'console_message',
      'console_session',
    ]);
    expect(rows[0].def).toContain('WHEN ((new."senderID" IS NOT NULL))');
    expect(rows[0].def).toContain('circle_console_message_event()');
    expect(rows[1].def).toContain('circle_console_session_event()');
  });

  it("collapses one sender's messages inside a 5-minute bucket into the first message", async () => {
    // 12:00:00 起每 20 秒一条,最后一条 12:03:00,全部落在 [12:00, 12:05) 桶内。
    for (let i = 0; i < 10; i += 1) {
      const at = new Date(Date.UTC(2026, 9, 25, 12, 0, i * 20));
      await insertMessage(db, `m${i}`, 'u1', at.toISOString().slice(0, 23));
    }
    expect(
      (await db.query('SELECT count(*)::int AS n FROM "ChatMessage"')).rows[0]
        .n,
    ).toBe(10);

    const rows = await events('MESSAGE_SENT');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userID: 'u1',
      source: 'SERVER',
      entityType: 'ChatMessage',
      entityID: 'm0',
      at: '2026-10-25 12:00:00.000',
    });
    // 运营台分页游标(console-operations.service.ts 的 pageCursor)只认
    // 36 位 uuid 或 64 位 hex 的 id;桶键原文进游标会被判成无效。
    expect(rows[0].id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('opens a new event when the next bucket starts and keeps senders apart', async () => {
    await insertMessage(db, 'a1', 'u1', '2026-10-25 12:04:59.999');
    await insertMessage(db, 'a2', 'u1', '2026-10-25 12:05:00.000');
    await insertMessage(db, 'b1', 'u2', '2026-10-25 12:04:00.000');

    const rows = await events('MESSAGE_SENT');
    expect(rows.map((row) => [row.userID, row.entityID])).toEqual([
      ['u2', 'b1'],
      ['u1', 'a1'],
      ['u1', 'a2'],
    ]);
  });

  it('buckets by the message timestamp regardless of the session TimeZone', async () => {
    await db.query(`SET TIME ZONE 'Asia/Shanghai'`);
    await insertMessage(db, 'z1', 'u1', '2026-10-25 12:00:00');
    await insertMessage(db, 'z2', 'u1', '2026-10-25 12:04:59');
    await insertMessage(db, 'z3', 'u1', '2026-10-25 12:05:00');

    const rows = await events('MESSAGE_SENT');
    expect(rows.map((row) => [row.entityID, row.at])).toEqual([
      ['z1', '2026-10-25 12:00:00.000'],
      ['z3', '2026-10-25 12:05:00.000'],
    ]);
  });

  it('accepts messages from senders outside User or without a sender and records nothing', async () => {
    await insertMessage(db, 'g1', 'temp-chat-guest', '2026-10-25 12:00:00');
    await insertMessage(db, 's1', null, '2026-10-25 12:00:00');

    expect(
      (await db.query('SELECT count(*)::int AS n FROM "ChatMessage"')).rows[0]
        .n,
    ).toBe(2);
    expect(await events('MESSAGE_SENT')).toEqual([]);
  });

  describe('concurrent sends into the same bucket', () => {
    let first: Client;
    let second: Client;

    beforeEach(async () => {
      first = new Client({
        connectionString: process.env.POSTGRES_TEST_DATABASE_URL,
      });
      second = new Client({
        connectionString: process.env.POSTGRES_TEST_DATABASE_URL,
      });
      for (const client of [first, second]) {
        await client.connect();
        await client.query(`SET search_path TO "${isolated.schema}", public`);
      }
    });

    afterEach(async () => {
      for (const client of [first, second]) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    });

    /**
     * 第二个发送事务必须真的卡在桶事件的主键上,断言才有意义。返回值包一层:
     * async 函数直接 return 一个 promise 会被摊平成「等它完成」,测试就自锁了。
     */
    async function startBlockedInsert(
      id: string,
      at: string,
    ): Promise<{ pending: Promise<unknown> }> {
      const pid = (
        await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      await second.query('BEGIN');
      const pending = insertMessage(second, id, 'u1', at);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { rows } = await db.query<{ waiting: boolean }>(
          `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
          [pid],
        );
        if (rows[0]?.waiting) return { pending };
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error('second insert never waited on the bucket event');
    }

    it('lets the waiting insert succeed without a second event once the first commits', async () => {
      await first.query('BEGIN');
      await insertMessage(first, 'c1', 'u1', '2026-10-25 12:01:00');
      const { pending } = await startBlockedInsert('c2', '2026-10-25 12:02:00');
      await first.query('COMMIT');
      await pending;
      await second.query('COMMIT');

      expect(
        (await db.query('SELECT count(*)::int AS n FROM "ChatMessage"')).rows[0]
          .n,
      ).toBe(2);
      expect((await events('MESSAGE_SENT')).map((row) => row.entityID)).toEqual(
        ['c1'],
      );
    });

    it('hands the bucket to the waiting insert when the first transaction rolls back', async () => {
      await first.query('BEGIN');
      await insertMessage(first, 'r1', 'u1', '2026-10-25 12:01:00');
      const { pending } = await startBlockedInsert('r2', '2026-10-25 12:02:00');
      await first.query('ROLLBACK');
      await pending;
      await second.query('COMMIT');

      const rows = await events('MESSAGE_SENT');
      expect(rows.map((row) => row.entityID)).toEqual(['r2']);
      expect(rows[0].at).toBe('2026-10-25 12:02:00.000');
    });
  });

  it('records SESSION_CREATED only for the first row of a token family', async () => {
    const insertToken = (id: string, userId: string, familyId: string) =>
      db.query(
        `INSERT INTO "RefreshToken" (id, "userId", "familyId") VALUES ($1, $2, $3)`,
        [id, userId, familyId],
      );
    await insertToken('t1', 'u1', 'family-a');
    // 续签:RefreshTokenService.rotate 新行沿用旧行的 familyId。
    await insertToken('t2', 'u1', 'family-a');
    await insertToken('t3', 'u1', 'family-a');
    // 新登录:新 family。
    await insertToken('t4', 'u1', 'family-b');
    await insertToken('t5', 'u2', 'family-c');

    const rows = await events('SESSION_CREATED');
    expect(
      rows.map((row) => [row.userID, row.entityType, row.entityID]),
    ).toEqual([
      ['u1', 'RefreshToken', 't1'],
      ['u1', 'RefreshToken', 't4'],
      ['u2', 'RefreshToken', 't5'],
    ]);
  });
});
