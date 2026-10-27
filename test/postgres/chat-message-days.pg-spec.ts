import {
  messageDaysQuery,
  messageDayWindows,
} from 'src/chat/chat-message-days.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 日期日历「哪些天有聊天记录」在真 PostgreSQL 上的口径与成本。
 *
 * 原来不带 orderBy 取 5000 行 createdAt 回应用去重:活跃月份超过 5000 条时,取回哪
 * 5000 条由执行计划决定,随机漏掉一些天。现在按客户端时区规则(应用里算好每天的
 * [start, end))逐天问库里有没有一条可见消息:每天一次索引探测,探到第一条就停。
 */
describePostgres('message days calendar (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const days = async (
    conversationId: string,
    floor: number,
    windows: ReturnType<typeof messageDayWindows>,
  ) => {
    const q = messageDaysQuery(conversationId, floor, windows);
    const { rows } = await s.db.query<{ day: string }>(q.text, q.values);
    return rows.map((row) => row.day).sort();
  };

  const insert = async (
    conversationId: string,
    rows: Array<{
      height: number;
      at: string;
      deleted?: boolean;
      burnExpiresAt?: string;
    }>,
  ) => {
    for (const row of rows) {
      await s.db.query(
        `INSERT INTO "ChatMessage" (id, "conversationID", height, deleted, "createdAt", "burnExpiresAt")
         VALUES ($1, $2, $3, $4, $5::timestamp, $6::timestamp)`,
        [
          `${conversationId}-${row.height}`,
          conversationId,
          row.height,
          row.deleted ?? false,
          row.at,
          row.burnExpiresAt ?? null,
        ],
      );
    }
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('chat_message_days');
    await s.db.query(`
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL, height integer NOT NULL,
        deleted boolean NOT NULL DEFAULT false, "createdAt" timestamp(3) NOT NULL,
        "burnExpiresAt" timestamp(3)
      );
      CREATE UNIQUE INDEX "ChatMessage_conversationID_height_key" ON "ChatMessage"("conversationID", height);
      CREATE INDEX "ChatMessage_conversationID_createdAt_idx" ON "ChatMessage"("conversationID", "createdAt");
      CREATE INDEX "ChatMessage_live_conversation_createdAt_idx" ON "ChatMessage"("conversationID", "createdAt")
        WHERE deleted = false;
    `);
    // 东八区边界:UTC 8/4 16:00 = 当地 8/5 00:00。
    await insert('cst', [
      { height: 1, at: '2026-07-31T15:59:59.999' }, // 当地 7/31 23:59:59.999,不在 8 月
      { height: 2, at: '2026-07-31T16:00:00' }, // 当地 8/1 00:00
      { height: 3, at: '2026-08-04T15:59:59.999' }, // 当地 8/4 23:59:59.999
      { height: 4, at: '2026-08-05T15:00:00' }, // 当地 8/5 23:00
      { height: 5, at: '2026-08-31T15:59:59' }, // 当地 8/31 23:59:59
      { height: 6, at: '2026-08-31T16:00:00' }, // 当地 9/1,不在 8 月
      { height: 7, at: '2026-08-10T04:00:00', deleted: true }, // 焚毁墓碑
      {
        height: 8,
        at: '2026-08-11T04:00:00',
        burnExpiresAt: '2026-08-11T05:00:00', // 已到期、尚未被扫掉
      },
      {
        height: 9,
        at: '2026-08-12T04:00:00',
        burnExpiresAt: '2099-01-01T00:00:00',
      },
    ]);
    // 洛杉矶 3/8 凌晨切夏令时:UTC 3/8 07:30 = 3/7 23:30 PST,08:30 = 3/8 00:30 PST,
    // UTC 3/9 06:30 = 3/8 23:30 PDT,07:30 = 3/9 00:30 PDT。
    await insert('pst', [
      { height: 1, at: '2026-03-08T07:30:00' },
      { height: 2, at: '2026-03-09T06:30:00' },
      { height: 3, at: '2026-03-09T07:30:00' },
      { height: 4, at: '2026-03-01T07:59:00' }, // 2/28 23:59 PST,不在 3 月
    ]);
    // 一个活跃月:每天 300 条,共 9000 多条 —— 原来 take 5000 会随机漏天。
    await s.db.query(`
      INSERT INTO "ChatMessage" (id, "conversationID", height, "createdAt")
      SELECT 'busy-' || g, 'busy', g, TIMESTAMP '2026-04-01' + (g * INTERVAL '288 seconds')
      FROM generate_series(1, 9000) g
    `);
    await s.db.query('ANALYZE "ChatMessage"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('buckets by the client offset at the local-midnight edges', async () => {
    expect(await days('cst', 0, messageDayWindows(2026, 7, -480))).toEqual([
      '2026-08-01',
      '2026-08-04',
      '2026-08-05',
      '2026-08-12',
      '2026-08-31',
    ]);
  });

  it('buckets by the IANA zone across the DST switch', async () => {
    expect(
      await days(
        'pst',
        0,
        messageDayWindows(2026, 2, 0, 'America/Los_Angeles'),
      ),
    ).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
  });

  it('hides days that sit entirely below the personal clear floor', async () => {
    // 清空水位 3:8/1、8/4 两天只剩水位之下的消息。
    expect(await days('cst', 3, messageDayWindows(2026, 7, -480))).toEqual([
      '2026-08-05',
      '2026-08-12',
      '2026-08-31',
    ]);
  });

  it('marks every day of a month busier than the old 5000-row cap', async () => {
    const result = await days('busy', 0, messageDayWindows(2026, 3, 0));

    expect(result).toHaveLength(30);
    expect(result[0]).toBe('2026-04-01');
    expect(result[29]).toBe('2026-04-30');
  });

  it('probes each day through the live (conversationID, createdAt) index', async () => {
    const q = messageDaysQuery('busy', 0, messageDayWindows(2026, 3, 0));
    const plan = await explainPlan(s.db, q.text, q.values);

    expect(plan).toContain('ChatMessage_live_conversation_createdAt_idx');
    expect(plan).not.toContain('Seq Scan');
  });
});
