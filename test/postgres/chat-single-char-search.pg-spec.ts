import {
  recentTextMatchesQuery,
  SINGLE_CHAR_SEARCH_WINDOW,
} from 'src/chat/chat-text-search.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 单字全局搜索在真 PostgreSQL 上只看每个会话最近 SINGLE_CHAR_SEARCH_WINDOW 条:
 * 窗口外的旧命中不返回,翻页游标也只在窗口里往下走;读取走
 * (conversationID, createdAt) WHERE deleted = false 的部分索引。
 */
describePostgres('single-character global search window (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const base = new Date('2026-10-01T00:00:00Z').getTime();

  const search = async (
    conversationIds: string[],
    pattern: string,
    before: { createdAt: Date; id: string } | null = null,
    limit = 200,
  ) => {
    const q = recentTextMatchesQuery(conversationIds, pattern, before, limit);
    const { rows } = await s.db.query<{ id: string; createdAt: Date }>(
      q.text,
      q.values,
    );
    return rows;
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('single_char_search');
    await s.db.query(`
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL,
        type text NOT NULL DEFAULT 'text', deleted boolean NOT NULL DEFAULT false,
        content jsonb NOT NULL, "burnExpiresAt" timestamp,
        "createdAt" timestamp NOT NULL
      );
      CREATE INDEX "ChatMessage_live_conversation_createdAt_idx"
        ON "ChatMessage" ("conversationID", "createdAt") WHERE deleted = false;
    `);
    // big:窗口 + 10 条。最老的 10 条(落在窗口外)和最新的 3 条含「吃」,中间是噪音。
    await s.db.query(
      `INSERT INTO "ChatMessage" (id, "conversationID", content, "createdAt")
       SELECT 'big-' || lpad(g::text, 4, '0'), 'big',
              jsonb_build_object('text', CASE WHEN g <= 10 OR g > $1 + 7 THEN '今晚吃什么' ELSE '收到' END),
              to_timestamp($2 / 1000.0 + g) AT TIME ZONE 'UTC'
       FROM generate_series(1, $1 + 10) g`,
      [SINGLE_CHAR_SEARCH_WINDOW, base],
    );
    await s.db
      .query(`INSERT INTO "ChatMessage" (id, "conversationID", type, deleted, content, "burnExpiresAt", "createdAt") VALUES
      ('small-text', 'small', 'text', false, '{"text":"吃了吗"}', NULL, '2026-10-02T00:00:00'),
      ('small-quote', 'small', 'quote', false, '{"text":"吃"}', NULL, '2026-10-02T00:00:01'),
      ('small-image', 'small', 'image', false, '{"text":"吃"}', NULL, '2026-10-02T00:00:02'),
      ('small-deleted', 'small', 'text', true, '{"text":"吃"}', NULL, '2026-10-02T00:00:03'),
      ('small-burned', 'small', 'text', false, '{"text":"吃"}', now() - interval '1 minute', '2026-10-02T00:00:04'),
      ('small-percent', 'small', 'text', false, '{"text":"完成 100%"}', NULL, '2026-10-02T00:00:05'),
      ('other', 'not-mine', 'text', false, '{"text":"吃"}', NULL, '2026-10-02T00:00:06')`);
    await s.db.query('ANALYZE "ChatMessage"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('only finds matches inside each conversation’s recent window', async () => {
    const ids = (await search(['big'], '%吃%')).map((row) => row.id);

    expect(ids).toHaveLength(3);
    expect(ids.every((id) => Number(id.slice(4)) > 10)).toBe(true);
  });

  it('keeps type, deletion, burn and conversation scoping', async () => {
    const ids = (await search(['small'], '%吃%')).map((row) => row.id);

    expect(ids).toEqual(['small-quote', 'small-text']);
  });

  it('matches LIKE metacharacters literally when escaped by the caller', async () => {
    const ids = (await search(['small'], '%100\\%%')).map((row) => row.id);

    expect(ids).toEqual(['small-percent']);
  });

  it('pages with the cursor without leaving the window', async () => {
    const first = await search(['big', 'small'], '%吃%', null, 2);
    const rest = await search(
      ['big', 'small'],
      '%吃%',
      first[first.length - 1],
      200,
    );

    expect(first).toHaveLength(2);
    // big 窗口里 3 条 + small 2 条,第二页接着拿剩下的 3 条,窗口外的老消息一条不出。
    expect(rest).toHaveLength(3);
    expect(
      [...first, ...rest].filter((row) => row.id.startsWith('big-')),
    ).toHaveLength(3);
  });

  it('reads each conversation through the live (conversationID, createdAt) index', async () => {
    // 测试表只有几百行,规划器会觉得顺序扫描更便宜;关掉它看「索引用不用得上」。
    await s.db.query('SET enable_seqscan = off');
    try {
      const q = recentTextMatchesQuery(['big', 'small'], '%吃%', null, 200);
      const plan = await explainPlan(s.db, q.text, q.values);

      expect(plan).toContain('ChatMessage_live_conversation_createdAt_idx');
      expect(plan).not.toContain('Seq Scan');
    } finally {
      await s.db.query('RESET enable_seqscan');
    }
  });
});
