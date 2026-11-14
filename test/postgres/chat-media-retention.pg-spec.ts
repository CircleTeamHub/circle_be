import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expiredMediaCandidatesQuery,
  purgeExpiredMediaQuery,
} from 'src/chat/chat-media-retention.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 聊天媒体保留期清理的两条原生 SQL 在真 PostgreSQL 上的语义与成本:
 * - 候选扫描只取到期、仍带 key、非焚毁的某一类媒体,并且走 20261111000000 的部分索引
 *   (type 字面量与索引谓词一致才行);
 * - 清理语句去掉 key/地址、标 expired、留下排版字段,带回旧 key,跳过被收藏的消息。
 */
const MIGRATIONS = [
  '20261111000000_chat_message_media_retention_index',
  '20261111000100_user_collection_source_index',
];

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

const DAY = 24 * 60 * 60 * 1000;

describePostgres('chat media retention (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const now = Date.now();
  const cutoff = (days: number) => new Date(now - days * DAY);

  beforeAll(async () => {
    s = await openIsolatedSchema('chat_media_retention');
    await s.db.query(`
      CREATE TABLE "ChatConversation" (id text PRIMARY KEY);
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL, type text NOT NULL,
        content jsonb NOT NULL, deleted boolean NOT NULL DEFAULT false,
        "burnDurationSec" integer, "burnExpiresAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "ChatMessage_conversationID_createdAt_idx" ON "ChatMessage" ("conversationID", "createdAt");
      CREATE TYPE "CollectionType" AS ENUM ('CHAT', 'VIDEO', 'VOICE', 'MESSAGE', 'NOTE');
      CREATE TABLE "UserCollection" (
        id text PRIMARY KEY, type "CollectionType" NOT NULL, "sourceID" text, payload jsonb
      );
      INSERT INTO "ChatConversation" SELECT 'c' || g FROM generate_series(1, 2000) g;
      -- 20 万条背景消息:大半是文字,媒体分布在过去两年,时间按 UTC 存(同 Prisma)。
      INSERT INTO "ChatMessage"
      SELECT 'm' || g, 'c' || (g % 2000 + 1),
             (ARRAY['text','text','text','image','video','voice'])[g % 6 + 1],
             CASE WHEN g % 6 < 3 THEN '{"text":"hi"}'::jsonb
                  ELSE jsonb_build_object('key', 'chat/u/' || g, 'width', 100) END,
             g % 11 = 0, NULL, NULL,
             (now() AT TIME ZONE 'UTC') - (g % 730) * interval '1 day'
      FROM generate_series(1, 200000) g;
      INSERT INTO "UserCollection" SELECT 'col' || g, 'CHAT', 'm' || (g * 37), NULL FROM generate_series(1, 5000) g;
    `);
    for (const migration of MIGRATIONS) {
      const sql = readFileSync(
        join(process.cwd(), 'prisma/migrations', migration, 'migration.sql'),
        'utf8',
      );
      for (const statement of statements(sql)) await s.db.query(statement);
    }
    await s.db.query('ANALYZE "ChatMessage"');
    await s.db.query('ANALYZE "UserCollection"');
  });

  afterAll(async () => {
    await s?.close();
  });

  const insert = (
    id: string,
    type: string,
    ageDays: number,
    content: Record<string, unknown>,
    extra: { burnDurationSec?: number; deleted?: boolean } = {},
  ) =>
    s.db.query(
      `INSERT INTO "ChatMessage" VALUES ($1, 'fixture', $2, $3, $4, $5, NULL,
         (now() AT TIME ZONE 'UTC') - $6 * interval '1 day')`,
      [
        id,
        type,
        JSON.stringify(content),
        extra.deleted ?? false,
        extra.burnDurationSec ?? null,
        ageDays,
      ],
    );

  it('picks only expired, still-keyed, non-burn media of the scanned type', async () => {
    await insert('fx-old-video', 'video', 31, { key: 'chat/u1/a.mp4' });
    await insert('fx-new-video', 'video', 29, { key: 'chat/u1/b.mp4' });
    await insert(
      'fx-burn-video',
      'video',
      90,
      { key: 'chat/u1/c.mp4' },
      { burnDurationSec: 60 },
    );
    await insert('fx-purged-video', 'video', 90, { expired: true });
    await insert('fx-old-image', 'image', 31, { key: 'chat/u1/d.jpg' });

    const query = expiredMediaCandidatesQuery({
      type: 'video',
      cutoff: cutoff(30),
      limit: 100_000,
    });
    const { rows } = await s.db.query<{ id: string }>(query.text, query.values);
    const ids = rows.map((row) => row.id);

    expect(ids).toContain('fx-old-video');
    expect(ids).not.toContain('fx-new-video');
    expect(ids).not.toContain('fx-burn-video');
    expect(ids).not.toContain('fx-purged-video');
    expect(ids).not.toContain('fx-old-image');
  });

  it('range-scans the retention index for each type', async () => {
    for (const type of ['video', 'image']) {
      const query = expiredMediaCandidatesQuery({
        type,
        cutoff: cutoff(type === 'video' ? 30 : 365),
        after: { createdAt: cutoff(700), id: 'm1' },
        limit: 500,
      });
      const plan = await explainPlan(s.db, query.text, query.values);
      expect(plan).toContain('ChatMessage_media_retention_idx');
      expect(plan).not.toContain('Seq Scan');
    }
  });

  it('rewrites expired media, returns the old keys and spares collected messages', async () => {
    await insert('fx-purge', 'video', 40, {
      key: 'chat/u1/p.mp4',
      thumbKey: 'chat/u1/p.jpg',
      width: 720,
      height: 1280,
      duration: 12,
    });
    await insert('fx-collected', 'video', 40, {
      key: 'chat/u1/k.mp4',
      width: 1,
    });
    await s.db.query(
      `INSERT INTO "UserCollection" VALUES ('fx-col', 'CHAT', 'fx-collected', NULL)`,
    );

    const purge = purgeExpiredMediaQuery(['fx-purge', 'fx-collected']);
    const { rows } = await s.db.query(purge.text, purge.values);
    expect(rows).toEqual([
      {
        id: 'fx-purge',
        key: 'chat/u1/p.mp4',
        thumbKey: 'chat/u1/p.jpg',
        coverKey: null,
      },
    ]);

    const stored = await s.db.query<{ id: string; content: unknown }>(
      `SELECT id, content FROM "ChatMessage" WHERE id IN ('fx-purge', 'fx-collected') ORDER BY id`,
    );
    expect(stored.rows).toEqual([
      { id: 'fx-collected', content: { key: 'chat/u1/k.mp4', width: 1 } },
      {
        id: 'fx-purge',
        content: { width: 720, height: 1280, duration: 12, expired: true },
      },
    ]);

    // 已经清过的不再被取到、也不会被改第二遍。
    const again = await s.db.query(purge.text, purge.values);
    expect(again.rows).toEqual([]);
  });

  it('lets only real message collections pin media, not a note naming it as its source', async () => {
    await insert('fx-note-forged', 'video', 40, { key: 'chat/u1/f.mp4' });
    await insert('fx-note-message', 'video', 40, { key: 'chat/u1/m.mp4' });
    // 普通笔记收藏的 sourceID 是客户端自报的,指向一条聊天消息也不能让它永不过期;
    // 收藏聊天消息走的 NOTE + kind=openim-message 是服务端校验过的,照常保护。
    await s.db.query(
      `INSERT INTO "UserCollection" VALUES
         ('fx-forged', 'NOTE', 'fx-note-forged', '{"noteId":"n1"}'),
         ('fx-note-col', 'NOTE', 'fx-note-message',
          '{"kind":"openim-message","messageID":"fx-note-message"}')`,
    );

    const purge = purgeExpiredMediaQuery(['fx-note-forged', 'fx-note-message']);
    const { rows } = await s.db.query<{ id: string }>(purge.text, purge.values);
    expect(rows.map((row) => row.id)).toEqual(['fx-note-forged']);
  });
});
