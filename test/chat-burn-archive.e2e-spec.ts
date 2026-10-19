import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const databaseUrl = process.env.BURN_ARCHIVE_TEST_DATABASE_URL;
if (
  databaseUrl &&
  (process.env.NODE_ENV !== 'test' ||
    !/test/.test(new URL(databaseUrl).pathname))
) {
  throw new Error(
    'Burn archive integration requires an isolated test database',
  );
}
const integration = databaseUrl ? describe : describe.skip;
integration(
  'read-started burn and 180-day archive PostgreSQL integration',
  () => {
    let db: Client;
    const schema = `burn_archive_${process.pid}`;
    const migration = (name: string) =>
      readFileSync(
        join(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      );
    const service = readFileSync(
      join(process.cwd(), 'src/chat/chat.service.ts'),
      'utf8',
    );
    const end =
      'SELECT COALESCE(MAX("revision"), 0)::integer AS revision FROM started';
    const template = service.slice(
      service.indexOf('WITH started AS (UPDATE'),
      service.indexOf(end) + end.length,
    );
    let index = 0;
    const startSql = template.replace(/\$\{[^}]+\}/g, () => `$${++index}`);
    const joined = new Date('2020-01-01Z');
    beforeAll(async () => {
      db = new Client({ connectionString: databaseUrl });
      await db.connect();
      await db.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE "ChatConversation" (id text primary key, "nextHeight" integer default 10, "nextRevision" integer default 10, "clearedBeforeHeight" integer default 0);
      CREATE TABLE "ChatMember" ("conversationID" text, "userID" text, "leftAt" timestamp, "joinedAt" timestamp, "lastReadHeight" integer, "clearedBeforeHeight" integer default 0);
      CREATE TABLE "ChatMessage" (id text primary key, "conversationID" text, height integer, type text default 'text', "senderID" text, "createdAt" timestamp, "burnDurationSec" integer, "burnExpiresAt" timestamp, deleted boolean default false, "revokedAt" timestamp, "editedAt" timestamp, content jsonb default '{"text":"private"}', revision integer default 0, "clientMessageId" text);
      CREATE TABLE "E2eeRecovery" (id text primary key, purpose text, "userID" text);
      CREATE TABLE "E2eeArchive" (id text primary key, "messageID" text, "recoveryID" text);
    `);
      await db.query(migration('20261019000000_read_started_burn_revision'));
      await db.query(
        `CREATE TRIGGER chat_message_assign_revision BEFORE INSERT OR UPDATE ON "ChatMessage" FOR EACH ROW EXECUTE FUNCTION chat_message_assign_revision()`,
      );
      await db.query(migration('20261019000100_pending_read_burn_index'));
      await db.query(migration('20261019000200_burn_audit_archive'));
      await db.query(`CREATE TRIGGER e2ee_message_retention AFTER UPDATE OF deleted, "revokedAt" ON "ChatMessage" FOR EACH ROW EXECUTE FUNCTION purge_e2ee_message_archive();
      CREATE TRIGGER e2ee_conversation_retention AFTER UPDATE OF "clearedBeforeHeight" ON "ChatConversation" FOR EACH ROW EXECUTE FUNCTION purge_e2ee_cleared_archive();`);
    });
    afterAll(async () => {
      if (db) {
        try {
          await db.query('ROLLBACK');
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await db.end();
        }
      }
    });
    beforeEach(async () => {
      await db.query(`TRUNCATE "ChatBurnArchive", "E2eeArchive", "E2eeRecovery", "ChatMessage", "ChatMember", "ChatConversation";
      INSERT INTO "ChatConversation" (id) VALUES ('c1');
      INSERT INTO "ChatMember" ("conversationID","userID","joinedAt","lastReadHeight") VALUES ('c1','author','2020-01-01',0),('c1','reader','2020-01-01',0);
      INSERT INTO "ChatMessage" (id,"conversationID",height,"senderID","createdAt","burnDurationSec") VALUES ('m1','c1',1,'author','2021-01-01',60);`);
    });
    const row = async () =>
      (await db.query('SELECT * FROM "ChatMessage" WHERE id=\'m1\'')).rows[0];
    const start = async (user = 'reader', floor = 0, joinedAt = joined) =>
      (await db.query(startSql, ['c1', 1, floor, user, joinedAt])).rows[0]
        .revision;
    const burn = async () =>
      db.query(
        `UPDATE "ChatMessage" SET "burnExpiresAt"=NOW()-INTERVAL '1 second' WHERE id='m1'; UPDATE "ChatMessage" SET deleted=true, content='{}' WHERE id='m1'`,
      );
    it('keeps unread messages and starts a fixed timer at the recipient read, never at send', async () => {
      expect((await row()).burnExpiresAt).toBeNull();
      const before = Date.now();
      expect(await start()).toBeGreaterThan(0);
      const first = await row();
      expect(first.burnExpiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 59900,
      );
      expect(first.burnExpiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 60100,
      );
      expect(await start()).toBe(0);
      expect((await row()).burnExpiresAt).toEqual(first.burnExpiresAt);
      expect((await row()).revision).toEqual(first.revision);
    });
    it('excludes author receipts, cleared history, and members joining after send', async () => {
      expect(await start('author')).toBe(0);
      expect(await start('reader', 1)).toBe(0);
      expect(await start('reader', 0, new Date('2022-01-01Z'))).toBe(0);
      expect((await row()).burnExpiresAt).toBeNull();
    });
    it('atomically retains burned content for exactly 180 days while redacting the user row', async () => {
      await burn();
      const archive = (await db.query('SELECT * FROM "ChatBurnArchive"'))
        .rows[0];
      expect(archive.content).toEqual({ text: 'private' });
      expect(
        archive.retainUntil.getTime() - archive.burnExpiresAt.getTime(),
      ).toBe(180 * 86400_000);
      expect((await row()).content).toEqual({});
      await db.query(`UPDATE "ChatMessage" SET deleted=true WHERE id='m1'`);
      expect((await db.query('SELECT * FROM "ChatBurnArchive"')).rowCount).toBe(
        1,
      );
    });
    it('does not archive a recall or resurrect content outside the 180-day retention window', async () => {
      await db.query(
        `UPDATE "ChatMessage" SET "revokedAt"=NOW() WHERE id='m1'`,
      );
      await burn();
      expect((await db.query('SELECT * FROM "ChatBurnArchive"')).rowCount).toBe(
        0,
      );
    });
    it('does not retain a delayed burn older than 180 days', async () => {
      await db.query(
        `UPDATE "ChatMessage" SET "burnExpiresAt"=NOW()-INTERVAL '181 days' WHERE id='m1'; UPDATE "ChatMessage" SET deleted=true, content='{}' WHERE id='m1'`,
      );
      expect((await db.query('SELECT * FROM "ChatBurnArchive"')).rowCount).toBe(
        0,
      );
    });
    it('retains audit recovery while deleting app recovery, including a subsequent user clear', async () => {
      await db.query(
        `INSERT INTO "E2eeRecovery" VALUES ('app','APP','reader'),('audit','AUDIT','admin'); INSERT INTO "E2eeArchive" VALUES ('app-copy','m1','app'),('audit-copy','m1','audit')`,
      );
      await burn();
      expect((await db.query('SELECT id FROM "E2eeArchive"')).rows).toEqual([
        { id: 'audit-copy' },
      ]);
      await db.query(
        `UPDATE "ChatConversation" SET "clearedBeforeHeight"=1 WHERE id='c1'`,
      );
      expect((await db.query('SELECT id FROM "E2eeArchive"')).rows).toEqual([
        { id: 'audit-copy' },
      ]);
    });
    it('rolls archive creation back together with a failed burn transaction', async () => {
      await db.query('BEGIN');
      await burn();
      await db.query('ROLLBACK');
      expect((await db.query('SELECT * FROM "ChatBurnArchive"')).rowCount).toBe(
        0,
      );
      expect((await row()).content).toEqual({ text: 'private' });
    });
  },
);
