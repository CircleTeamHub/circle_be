import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noteCardConversationsQuery } from 'src/note/note-card-recipients.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 笔记卡片接收人查询在真 PostgreSQL 上的口径与成本:sourceNoteId / 老卡片的 noteId
 * 任一指向目标笔记的有效卡片都算,会话去重;已删/已撤回/别的类型不算。成本上必须
 * 落在迁移建的两条部分表达式索引上 —— 规划器认不出谓词或表达式时只会静默退回全表扫描。
 */
describePostgres('note card recipient conversations query (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const INDEXES = [
    'ChatMessage_note_card_sourceNoteId_idx',
    'ChatMessage_note_card_noteId_idx',
  ];

  const conversationsFor = async (noteIds: string[]) => {
    const q = noteCardConversationsQuery(noteIds);
    const { rows } = await s.db.query<{ conversationID: string }>(
      q.text,
      q.values,
    );
    // 去重是口径的一部分，所以只排序、不转 Set。
    return rows
      .map((row) => row.conversationID)
      .sort((a, b) => a.localeCompare(b));
  };

  const insertMessage = async (
    id: string,
    conversationID: string,
    content: Record<string, unknown>,
    extra: { type?: string; deleted?: boolean; revoked?: boolean } = {},
  ) => {
    await s.db.query(
      `INSERT INTO "ChatMessage" (id, "conversationID", type, deleted, "revokedAt", content)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END, $6::jsonb)`,
      [
        id,
        conversationID,
        extra.type ?? 'note-card',
        extra.deleted ?? false,
        extra.revoked ?? false,
        JSON.stringify(content),
      ],
    );
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('note_card_recipients');
    await s.db.query(`
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL,
        type text NOT NULL, deleted boolean NOT NULL DEFAULT false,
        "revokedAt" timestamp, content jsonb NOT NULL
      );
    `);
    // CREATE INDEX CONCURRENTLY 不能放进多语句的隐式事务,和 Prisma 一样逐条执行。
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261025000000_note_card_reference_indexes/migration.sql',
      ),
      'utf8',
    );
    const statements = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(INDEXES.length);
    for (const statement of statements) {
      await s.db.query(statement);
    }
  });

  afterAll(async () => {
    await s?.close();
  });

  beforeEach(async () => {
    await s.db.query('TRUNCATE "ChatMessage"');
  });

  it('returns each conversation holding a live card for any pointer key once', async () => {
    await insertMessage('m1', 'conv-source', { sourceNoteId: 'note-a' });
    await insertMessage('m2', 'conv-source', { sourceNoteId: 'note-a' });
    // 老卡片没有 sourceNoteId,noteId 就是来源指针。
    await insertMessage('m3', 'conv-legacy', { noteId: 'note-a' });
    // 同一会话里两种键各命中一次,也只出现一次。
    await insertMessage('m4', 'conv-both', { sourceNoteId: 'note-b' });
    await insertMessage('m5', 'conv-both', { noteId: 'note-a' });
    await insertMessage('m6', 'conv-other-note', { sourceNoteId: 'note-z' });

    expect(await conversationsFor(['note-a', 'note-b'])).toEqual([
      'conv-both',
      'conv-legacy',
      'conv-source',
    ]);
    expect(await conversationsFor(['note-b'])).toEqual(['conv-both']);
    expect(await conversationsFor(['missing'])).toEqual([]);
  });

  it('ignores deleted, revoked and non-card messages', async () => {
    await insertMessage(
      'deleted',
      'conv-deleted',
      { sourceNoteId: 'note-a' },
      { deleted: true },
    );
    await insertMessage(
      'revoked',
      'conv-revoked',
      { sourceNoteId: 'note-a' },
      { revoked: true },
    );
    await insertMessage(
      'text',
      'conv-text',
      { noteId: 'note-a', text: 'note-a' },
      { type: 'text' },
    );
    await insertMessage('live', 'conv-live', { noteId: 'note-a' });

    expect(await conversationsFor(['note-a'])).toEqual(['conv-live']);
  });

  it('reads through both partial expression indexes instead of scanning ChatMessage', async () => {
    // 足够多的无关行,让「整表扫/整个主键扫」在代价上明显输给两条部分索引。
    await s.db.query(`
      INSERT INTO "ChatMessage" (id, "conversationID", type, content)
      SELECT 'filler-' || g, 'conv-' || (g % 97),
             CASE WHEN g % 3 = 0 THEN 'note-card' ELSE 'text' END,
             jsonb_build_object('sourceNoteId', 'other-' || g, 'noteId', 'other-' || g, 'text', 'hello')
      FROM generate_series(1, 5000) g
    `);
    await insertMessage('target', 'conv-target', { sourceNoteId: 'note-a' });
    await s.db.query('ANALYZE "ChatMessage"');

    await s.db.query('SET enable_seqscan = off');
    try {
      const q = noteCardConversationsQuery(['note-a', 'note-b']);
      const plan = await explainPlan(s.db, q.text, q.values);
      for (const index of INDEXES) {
        expect(plan).toContain(index);
      }
      expect(await conversationsFor(['note-a'])).toEqual(['conv-target']);
    } finally {
      await s.db.query('RESET enable_seqscan');
    }
  });
});
