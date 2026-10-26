import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lastMessagesQuery,
  unreadCountsQuery,
} from 'src/chat/chat-conversation-summary.query';
import { UNREAD_COUNT_CAP } from 'src/chat/chat.constants';
import {
  historyPageArgs,
  historyPageWhere,
} from 'src/chat/chat-history-page.query';
import type { HistoryFilters } from 'src/chat/chat.types';
import { capturePrisma, captureQueries } from './prisma-sql-capture';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 20261026000300 的两条部分索引在真 PostgreSQL 上的效果:焚毁墓碑(deleted = true,
 * 从不物理删除)堆起来之后,历史页 / 会话列表末条 / 未读数不再逐条跨过墓碑;
 * 「图片 / 视频 / 文件」页签按 (conversationID, type, height) 直接取,不沿整个会话
 * 倒扫再回表判断 type。
 *
 * 历史页的 SQL 现场生成:用 getHistory 自己的 historyPageWhere / historyPageArgs,
 * 交给只记录不执行的 Prisma 客户端(prisma-sql-capture),拿到 Prisma 7 实际编译出的
 * 语句和参数再来真库执行、EXPLAIN。源码里 where 改了,这里跟着变。
 * 末条与未读两条原生 SQL 直接用 src 里的构造器。
 */
const MIGRATION = '20261026000300_chat_message_live_height_indexes';
const NO_WINDOW = {
  viewerCutoff: null,
  viewerStartedAt: null,
  burnStartedAt: null,
  burnCutoff: null,
};

const capture = capturePrisma();
/** getHistory 不带关键词时发出的那条 findMany(向旧翻页,newest first)。 */
const historySql = async (
  conversationId: string,
  filters: HistoryFilters,
  take: number,
  beforeHeight?: number,
) => {
  const where = historyPageWhere({
    conversationId,
    heightFloor: 0,
    beforeHeight,
    filters,
    retention: NO_WINDOW,
  });
  const [query] = await captureQueries(capture.queries, () =>
    capture.prisma.chatMessage.findMany(historyPageArgs(where, false, take)),
  );
  return query;
};
/** big 的消息条数:最后 TOMBSTONE_TAIL 条全是焚毁墓碑,中间还夹着三成墓碑。 */
const BIG = 30_000;
const TOMBSTONE_TAIL = 4_000;

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('chat history live indexes (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const history = async (sql: string, values: unknown[]) => {
    const { rows } = await s.db.query<{
      height: number;
      type: string;
      deleted: boolean;
    }>(sql, values);
    return rows;
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('chat_history_live');
    await s.db.query(`
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL, height integer NOT NULL,
        "senderID" text, type text NOT NULL, content jsonb NOT NULL DEFAULT '{}',
        "clientMessageId" varchar(128), "requestHash" varchar(64), "replyToID" text,
        deleted boolean NOT NULL DEFAULT false, "deletedAt" timestamp(3),
        "revokedAt" timestamp(3), "revokedBy" text, "editedAt" timestamp(3),
        "contentHistory" jsonb, revision integer NOT NULL DEFAULT 0,
        "createdAt" timestamp(3) NOT NULL DEFAULT now(),
        "burnDurationSec" integer, "burnExpiresAt" timestamp(3)
      );
      CREATE UNIQUE INDEX "ChatMessage_conversationID_height_key" ON "ChatMessage"("conversationID", height);
      CREATE INDEX "ChatMessage_conversationID_createdAt_idx" ON "ChatMessage"("conversationID", "createdAt");
      CREATE INDEX "ChatMessage_live_conversation_createdAt_idx" ON "ChatMessage"("conversationID", "createdAt") WHERE deleted = false;
      CREATE INDEX "ChatMessage_burn_expiry_active_idx" ON "ChatMessage"("conversationID", "burnExpiresAt")
        WHERE deleted = false AND "burnExpiresAt" IS NOT NULL;
      CREATE INDEX "ChatMessage_pending_read_burn_idx" ON "ChatMessage"("conversationID", height)
        WHERE deleted = false AND "revokedAt" IS NULL AND "burnDurationSec" > 0 AND "burnExpiresAt" IS NULL;
    `);
    // big:每 97 条一张图、每 389 条一段视频、每 1499 条一个文件,其余是文本;三成是焚毁墓碑
    // (content 已清空、type 不变),最后 TOMBSTONE_TAIL 条整段都是墓碑。
    await s.db.query(
      `INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, deleted, "createdAt")
       SELECT 'big-' || g, 'big', g, CASE WHEN g % 2 = 0 THEN 'me' ELSE 'peer' END,
              CASE WHEN g % 97 = 0 THEN 'image' WHEN g % 389 = 0 THEN 'video'
                   WHEN g % 1499 = 0 THEN 'file' ELSE 'text' END,
              g > $1 - $2 OR g % 10 < 3,
              TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
       FROM generate_series(1, $1::int) g`,
      [BIG, TOMBSTONE_TAIL],
    );
    // 背景:200 个小会话各 100 条。
    await s.db.query(`
      INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, "createdAt")
      SELECT 'bg-' || c || '-' || g, 'bg-' || c, g, 'peer',
             CASE WHEN g % 20 = 0 THEN 'image' ELSE 'text' END,
             TIMESTAMP '2026-01-01' + g * INTERVAL '1 second'
      FROM generate_series(1, 200) c, generate_series(1, 100) g;
    `);
    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    );
    for (const statement of statements(migration)) {
      await s.db.query(statement);
    }
    await s.db.query('ANALYZE "ChatMessage"');
  });

  afterAll(async () => {
    await s?.close();
  });

  describe('results', () => {
    it('pages the image tab newest first, skipping tombstones', async () => {
      const q = await historySql('big', { types: ['image'] }, 5, BIG);
      const rows = await history(q.sql, q.args);
      const expected = Array.from({ length: BIG }, (_, i) => BIG - i)
        .filter((h) => h % 97 === 0 && h <= BIG - TOMBSTONE_TAIL && h % 10 >= 3)
        .slice(0, 5);

      expect(rows.map((row) => row.height)).toEqual(expected);
      expect(rows.every((row) => row.type === 'image' && !row.deleted)).toBe(
        true,
      );
    });

    it('pages a multi-type tab newest first, skipping tombstones', async () => {
      const q = await historySql('big', { types: ['video', 'file'] }, 50);
      const rows = await history(q.sql, q.args);
      const expected = Array.from({ length: BIG }, (_, i) => BIG - i)
        .filter(
          (h) =>
            (h % 389 === 0 || h % 1499 === 0) &&
            h % 97 !== 0 &&
            h <= BIG - TOMBSTONE_TAIL &&
            h % 10 >= 3,
        )
        .slice(0, 50);

      expect(rows.map((row) => row.height)).toEqual(expected);
    });

    it('takes the last live message below the tombstone tail', async () => {
      const q = lastMessagesQuery(['big', 'bg-1'], [NO_WINDOW, NO_WINDOW]);
      const { rows } = await s.db.query<{
        conversationID: string;
        height: number;
      }>(q.text, q.values);
      const byConversation = Object.fromEntries(
        rows.map((row) => [row.conversationID, row.height]),
      );
      const lastLive = Array.from(
        { length: BIG },
        (_, i) => BIG - TOMBSTONE_TAIL - i,
      ).find((h) => h % 10 >= 3);

      expect(byConversation).toEqual({ big: lastLive, 'bg-1': 100 });
    });

    it('counts unread live messages from others, capped', async () => {
      const floor = BIG - TOMBSTONE_TAIL - 20;
      const q = unreadCountsQuery(
        'me',
        [
          { conversationID: 'big', lastReadHeight: floor },
          { conversationID: 'bg-1', lastReadHeight: 0 },
        ],
        [NO_WINDOW, NO_WINDOW],
      );
      const { rows } = await s.db.query<{
        conversationID: string;
        count: string;
      }>(q.text, q.values);
      const counts = Object.fromEntries(
        rows.map((row) => [row.conversationID, Number(row.count)]),
      );
      const expectedBig = Array.from({ length: 20 }, (_, i) => floor + 1 + i)
        // peer 发的(奇数 height)、未焚毁的。
        .filter((h) => h % 2 === 1 && h % 10 >= 3).length;

      expect(counts).toEqual({
        big: expectedBig,
        'bg-1': Math.min(100, UNREAD_COUNT_CAP),
      });
    });
  });

  // 不关顺序扫描:规划器拿着 ANALYZE 的统计信息自己挑。
  describe('plans', () => {
    it('reads one-type history pages from the (conversationID, type, height) live index', async () => {
      const q = await historySql('big', { types: ['image'] }, 50, BIG);
      const plan = await explainPlan(s.db, q.sql, q.args);

      expect(plan).toContain('ChatMessage_live_conversation_type_height_idx');
      expect(plan).not.toContain('Seq Scan');
    });

    // 多类型时 PG16 没法顺着索引按 height 出序,只能取出这几类再排序;匹配稠密时
    // 规划器宁可沿 height 倒扫过滤(那也只扫几页就够一页)—— 这里是匹配稀疏、
    // 原来要把整个会话扫完的情形。
    it('reads sparse multi-type history pages from the same live index', async () => {
      const q = await historySql('big', { types: ['video', 'file'] }, 50);
      const plan = await explainPlan(s.db, q.sql, q.args);

      expect(plan).toContain('ChatMessage_live_conversation_type_height_idx');
      expect(plan).not.toContain('Seq Scan');
    });

    it('reads plain history pages from the live (conversationID, height) index', async () => {
      const q = await historySql('big', {}, 50);
      const plan = await explainPlan(s.db, q.sql, q.args);

      expect(plan).toContain('ChatMessage_live_conversation_height_idx');
      expect(plan).not.toContain('Seq Scan');
    });

    it('finds each last message through the live (conversationID, height) index', async () => {
      const q = lastMessagesQuery(['big', 'bg-1'], [NO_WINDOW, NO_WINDOW]);
      const plan = await explainPlan(s.db, q.text, q.values);

      expect(plan).toContain('ChatMessage_live_conversation_height_idx');
      expect(plan).not.toContain('Seq Scan');
    });

    it('counts unread through the live (conversationID, height) index', async () => {
      const q = unreadCountsQuery(
        'me',
        [
          { conversationID: 'big', lastReadHeight: 1000 },
          { conversationID: 'bg-1', lastReadHeight: 0 },
        ],
        [NO_WINDOW, NO_WINDOW],
      );
      const plan = await explainPlan(s.db, q.text, q.values);

      expect(plan).toContain('ChatMessage_live_conversation_height_idx');
      expect(plan).not.toContain('Seq Scan');
    });
  });
});
