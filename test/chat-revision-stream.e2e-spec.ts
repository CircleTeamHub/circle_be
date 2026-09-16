import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (process.env.NODE_ENV !== 'test' || !/(^|[_-])test($|[_-])/i.test(name)) {
    throw new Error(
      'Revision stream integration requires a test database and NODE_ENV=test',
    );
  }
}
const describePostgres = databaseUrl ? describe : describe.skip;

/**
 * 20260916000000_add_chat_revision_stream 的触发器必须在真库上验:
 * 应用层单测里 Prisma 是桩,取号逻辑一行都跑不到。
 * 每个用例一个事务,结束回滚,不在测试库里留行。
 */
describePostgres('chat revision stream PostgreSQL integration', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl! });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function inRollback(run: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      await run();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  async function createConversation(id: string): Promise<void> {
    await client.query(
      `INSERT INTO "ChatConversation" ("id", "type", "updatedAt")
       VALUES ($1, 'GROUP', CURRENT_TIMESTAMP)`,
      [id],
    );
  }

  async function insertMessage(
    conversationId: string,
    id: string,
    height: number,
  ): Promise<number> {
    const result = await client.query<{ revision: number }>(
      `INSERT INTO "ChatMessage" ("id", "conversationID", "height", "type", "content")
       VALUES ($1, $2, $3, 'text', '{"text":"hi"}')
       RETURNING "revision"`,
      [id, conversationId, height],
    );
    return result.rows[0].revision;
  }

  async function revisionOf(messageId: string): Promise<number> {
    const result = await client.query<{ revision: number }>(
      `SELECT "revision" FROM "ChatMessage" WHERE "id" = $1`,
      [messageId],
    );
    return result.rows[0].revision;
  }

  async function counterOf(conversationId: string): Promise<number> {
    const result = await client.query<{ nextRevision: number }>(
      `SELECT "nextRevision" FROM "ChatConversation" WHERE "id" = $1`,
      [conversationId],
    );
    return result.rows[0].nextRevision;
  }

  it('allocates one revision per created message, per conversation', async () => {
    await inRollback(async () => {
      await createConversation('rev-conv-a');
      await createConversation('rev-conv-b');

      expect(await insertMessage('rev-conv-a', 'rev-a1', 1)).toBe(1);
      expect(await insertMessage('rev-conv-a', 'rev-a2', 2)).toBe(2);
      // 另一个会话有自己的计数器。
      expect(await insertMessage('rev-conv-b', 'rev-b1', 1)).toBe(1);
      expect(await counterOf('rev-conv-a')).toBe(2);
      expect(await counterOf('rev-conv-b')).toBe(1);
    });
  });

  it('moves a message to a new revision on every client-visible change, never its height', async () => {
    await inRollback(async () => {
      await createConversation('rev-conv');
      await insertMessage('rev-conv', 'rev-m1', 1);
      await insertMessage('rev-conv', 'rev-m2', 2);

      await client.query(
        `UPDATE "ChatMessage"
         SET "content" = '{"text":"edited"}', "editedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'rev-m1'`,
      );
      expect(await revisionOf('rev-m1')).toBe(3);

      await client.query(
        `UPDATE "ChatMessage"
         SET "content" = '{}', "revokedAt" = CURRENT_TIMESTAMP, "revokedBy" = 'u1'
         WHERE "id" = 'rev-m1'`,
      );
      expect(await revisionOf('rev-m1')).toBe(4);

      await client.query(
        `UPDATE "ChatMessage"
         SET "deleted" = true, "deletedAt" = CURRENT_TIMESTAMP, "content" = '{}'
         WHERE "id" = 'rev-m2'`,
      );
      expect(await revisionOf('rev-m2')).toBe(5);
      expect(await counterOf('rev-conv')).toBe(5);

      const heights = await client.query<{ id: string; height: number }>(
        `SELECT "id", "height" FROM "ChatMessage"
         WHERE "conversationID" = 'rev-conv' ORDER BY "height"`,
      );
      expect(heights.rows).toEqual([
        { id: 'rev-m1', height: 1 },
        { id: 'rev-m2', height: 2 },
      ]);
    });
  });

  it('never reuses a backfilled revision in a conversation whose counter was never initialized', async () => {
    // 迁移只把存量消息回填成 revision = height,不整表初始化会话计数器:
    // 从没变过的会话 nextRevision 还是 0、nextHeight 是消息条数。取号必须越过它们。
    await inRollback(async () => {
      await createConversation('rev-conv-legacy');
      for (let height = 1; height <= 3; height += 1) {
        await insertMessage('rev-conv-legacy', `rev-legacy-${height}`, height);
      }
      await client.query(
        `UPDATE "ChatMessage" SET "revision" = "height"
         WHERE "conversationID" = 'rev-conv-legacy'`,
      );
      await client.query(
        `UPDATE "ChatConversation" SET "nextRevision" = 0, "nextHeight" = 3
         WHERE "id" = 'rev-conv-legacy'`,
      );

      // 自动回复/系统消息先插消息、后推 nextHeight:插入这一刻 nextHeight 还是 3。
      expect(await insertMessage('rev-conv-legacy', 'rev-legacy-4', 4)).toBe(4);
      await client.query(
        `UPDATE "ChatConversation" SET "nextHeight" = 4 WHERE "id" = 'rev-conv-legacy'`,
      );
      // 撤回一条存量消息、给另一条加回应:都分到比所有存量号更大的新号。
      await client.query(
        `UPDATE "ChatMessage" SET "content" = '{}', "revokedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'rev-legacy-2'`,
      );
      await client.query(
        `INSERT INTO "ChatMessageReaction" ("id", "messageID", "userID", "emoji")
         VALUES ('rev-legacy-r', 'rev-legacy-1', 'u2', '👍')`,
      );

      const rows = await client.query<{ id: string; revision: number }>(
        `SELECT "id", "revision" FROM "ChatMessage"
         WHERE "conversationID" = 'rev-conv-legacy' ORDER BY "revision"`,
      );
      expect(rows.rows).toEqual([
        { id: 'rev-legacy-3', revision: 3 },
        { id: 'rev-legacy-4', revision: 4 },
        { id: 'rev-legacy-2', revision: 5 },
        { id: 'rev-legacy-1', revision: 6 },
      ]);
      expect(await counterOf('rev-conv-legacy')).toBe(6);
    });
  });

  it('does not spend a revision on invisible changes', async () => {
    await inRollback(async () => {
      await createConversation('rev-conv');
      await insertMessage('rev-conv', 'rev-m1', 1);

      await client.query(
        `UPDATE "ChatMessage" SET "contentHistory" = '[{"text":"old"}]'
         WHERE "id" = 'rev-m1'`,
      );

      expect(await revisionOf('rev-m1')).toBe(1);
      expect(await counterOf('rev-conv')).toBe(1);
    });
  });

  it('re-revisions the parent message when a reaction is added or removed', async () => {
    await inRollback(async () => {
      await createConversation('rev-conv');
      await insertMessage('rev-conv', 'rev-m1', 1);

      await client.query(
        `INSERT INTO "ChatMessageReaction" ("id", "messageID", "userID", "emoji")
         VALUES ('rev-r1', 'rev-m1', 'u2', '👍')`,
      );
      expect(await revisionOf('rev-m1')).toBe(2);

      await client.query(
        `DELETE FROM "ChatMessageReaction" WHERE "id" = 'rev-r1'`,
      );
      expect(await revisionOf('rev-m1')).toBe(3);
      // 回应触发器换号之后,消息触发器不能再为同一次变更取第二个号。
      expect(await counterOf('rev-conv')).toBe(3);
    });
  });

  it('refuses to restore a recalled message or move one to another position', async () => {
    await inRollback(async () => {
      await createConversation('rev-conv');
      await insertMessage('rev-conv', 'rev-m1', 1);
      await client.query(
        `UPDATE "ChatMessage" SET "revokedAt" = CURRENT_TIMESTAMP, "content" = '{}'
         WHERE "id" = 'rev-m1'`,
      );
      await client.query('SAVEPOINT restore_attempt');
      await expect(
        client.query(
          `UPDATE "ChatMessage" SET "revokedAt" = NULL WHERE "id" = 'rev-m1'`,
        ),
      ).rejects.toThrow(/cannot be restored/);
      await client.query('ROLLBACK TO SAVEPOINT restore_attempt');

      await expect(
        client.query(
          `UPDATE "ChatMessage" SET "height" = 9 WHERE "id" = 'rev-m1'`,
        ),
      ).rejects.toThrow(/immutable/);
    });
  });

  it('exposes only committed revisions below the counter to a concurrent reader', async () => {
    // 写事务拿着会话行锁没提交时,另一条连接读到的计数器与消息必须一致:
    // 不会出现「计数器已前进、行还不可见」或反过来。
    const writer = new Client({ connectionString: databaseUrl! });
    await writer.connect();
    try {
      await client.query('BEGIN');
      await createConversation('rev-conv-concurrent');
      await insertMessage('rev-conv-concurrent', 'rev-c1', 1);
      await client.query('COMMIT');

      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO "ChatMessage" ("id", "conversationID", "height", "type", "content")
         VALUES ('rev-c2', 'rev-conv-concurrent', 2, 'text', '{}')`,
      );

      expect(await counterOf('rev-conv-concurrent')).toBe(1);
      const visible = await client.query(
        `SELECT "id" FROM "ChatMessage"
         WHERE "conversationID" = 'rev-conv-concurrent' AND "revision" <= 1`,
      );
      expect(visible.rows).toEqual([{ id: 'rev-c1' }]);

      await writer.query('COMMIT');
      expect(await counterOf('rev-conv-concurrent')).toBe(2);
      expect(await revisionOf('rev-c2')).toBe(2);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      await client.query(
        `DELETE FROM "ChatConversation" WHERE "id" = 'rev-conv-concurrent'`,
      );
    }
  });
});
