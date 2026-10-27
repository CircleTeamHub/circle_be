import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  traceCommentPreviewQuery,
  traceLikePreviewQuery,
} from 'src/trace/trace-preview.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 朋友圈点赞 / 评论预览在真 PostgreSQL 上的口径与成本（迁移 20261026000530 / 000540）：
 * - 每条动态各取前 N 条，LIMIT 在 SQL 里；排序、deleted 过滤、replyTo 映射与原先
 *   的嵌套 include 一致（评论不看 private，已删的父评论仍可被引用）；
 * - 热门动态上走 (traceID, createdAt) 与 (traceID, updatedAt) WHERE deleted = false
 *   两条索引，不把整条动态的点赞 / 评论读出来；
 * - 被新索引覆盖的 TraceComment_traceID_idx 删掉了。
 */
describePostgres('trace like / comment previews (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const MIGRATIONS: Array<[string, number]> = [
    ['prisma/migrations/20261026000530_trace_preview_indexes/migration.sql', 2],
    [
      'prisma/migrations/20261026000540_drop_trace_comment_trace_id_idx/migration.sql',
      1,
    ],
  ];

  const likes = async (traceIds: string[], limit: number) => {
    const q = traceLikePreviewQuery(traceIds, limit);
    return (
      await s.db.query<{
        traceID: string;
        userID: string;
        userNickname: string;
      }>(q.text, q.values)
    ).rows;
  };

  const comments = async (traceIds: string[], limit: number) => {
    const q = traceCommentPreviewQuery(traceIds, limit);
    return (
      await s.db.query<{
        id: string;
        traceID: string;
        userID: string;
        content: string;
        images: string[];
        createdAt: Date;
        userNickname: string;
        replyToID: string | null;
        replyToNickname: string | null;
      }>(q.text, q.values)
    ).rows;
  };

  const like = (
    traceID: string,
    userID: string,
    updatedAt: string,
    deleted = false,
  ) =>
    s.db.query(
      `INSERT INTO "traceLikeStat" (id, "traceID", "userID", deleted, "updatedAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [`like-${traceID}-${userID}`, traceID, userID, deleted, updatedAt],
    );

  const comment = (
    id: string,
    traceID: string,
    userID: string,
    createdAt: string,
    extra: { deleted?: boolean; private?: boolean; replyToID?: string } = {},
  ) =>
    s.db.query(
      `INSERT INTO "TraceComment"
         (id, content, images, deleted, private, "traceID", "userID", "replyToID", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        `content-${id}`,
        id === 'c-img' ? ['https://cdn.example/a.jpg'] : [],
        extra.deleted ?? false,
        extra.private ?? false,
        traceID,
        userID,
        extra.replyToID ?? null,
        createdAt,
      ],
    );

  beforeAll(async () => {
    s = await openIsolatedSchema('trace_preview');
    await s.db.query(`
      CREATE TABLE "User" (id text PRIMARY KEY, nickname text NOT NULL);
      CREATE TABLE "Trace" (id text PRIMARY KEY);
      CREATE TABLE "TraceComment" (
        id text PRIMARY KEY,
        content text NOT NULL DEFAULT '',
        images text[] NOT NULL DEFAULT '{}',
        deleted boolean NOT NULL DEFAULT false,
        private boolean NOT NULL DEFAULT false,
        "traceID" text NOT NULL REFERENCES "Trace"(id) ON DELETE CASCADE,
        "userID" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
        "replyToID" text REFERENCES "TraceComment"(id),
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "TraceComment_traceID_idx" ON "TraceComment" ("traceID");
      CREATE INDEX "TraceComment_userID_idx" ON "TraceComment" ("userID");
      CREATE TABLE "traceLikeStat" (
        id text PRIMARY KEY,
        "traceID" text NOT NULL REFERENCES "Trace"(id) ON DELETE CASCADE,
        "userID" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
        deleted boolean NOT NULL DEFAULT false,
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE UNIQUE INDEX "traceLikeStat_traceID_userID_key"
        ON "traceLikeStat" ("traceID", "userID");
    `);
    // CREATE / DROP INDEX CONCURRENTLY 不能放进多语句的隐式事务，和 Prisma 一样逐条执行。
    for (const [path, count] of MIGRATIONS) {
      const statements = readFileSync(join(process.cwd(), path), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      expect(statements).toHaveLength(count);
      for (const statement of statements) {
        await s.db.query(statement);
      }
    }
    await s.db.query(`
      INSERT INTO "User" (id, nickname)
      SELECT 'u' || g, 'nick-u' || g FROM generate_series(1, 6000) g;
      INSERT INTO "Trace" (id) VALUES ('t1'), ('t2'), ('t-empty'), ('hot');
    `);
  });

  afterAll(async () => {
    await s?.close();
  });

  beforeEach(async () => {
    await s.db.query('TRUNCATE "TraceComment", "traceLikeStat"');
  });

  it('keeps only the newest live likes of each trace, newest first', async () => {
    await like('t1', 'u1', '2026-06-01 00:00:01');
    await like('t1', 'u2', '2026-06-01 00:00:03');
    await like('t1', 'u3', '2026-06-01 00:00:02');
    // 取消点赞是软删，不进预览。
    await like('t1', 'u4', '2026-06-01 00:00:09', true);
    await like('t2', 'u5', '2026-06-01 00:00:00');

    const rows = await likes(['t1', 't2', 't-empty'], 2);

    expect(rows).toEqual([
      { traceID: 't1', userID: 'u2', userNickname: 'nick-u2' },
      { traceID: 't1', userID: 'u3', userNickname: 'nick-u3' },
      { traceID: 't2', userID: 'u5', userNickname: 'nick-u5' },
    ]);
  });

  it('keeps only the newest live comments of each trace with author and replied-to nicknames', async () => {
    await comment('c-root', 't1', 'u1', '2026-06-01 00:00:01', {
      deleted: true,
    });
    await comment('c-img', 't1', 'u2', '2026-06-01 00:00:02');
    // 回复一条已删的评论：原嵌套 include 的 replyTo 不看 deleted，照样带出来。
    await comment('c-reply', 't1', 'u3', '2026-06-01 00:00:03', {
      replyToID: 'c-root',
    });
    // private 评论原查询不滤，这里也不滤。
    await comment('c-private', 't1', 'u4', '2026-06-01 00:00:04', {
      private: true,
    });
    await comment('c-old', 't1', 'u5', '2026-06-01 00:00:00');
    await comment('c-t2', 't2', 'u6', '2026-06-01 00:00:00', {
      replyToID: 'c-img',
    });

    const rows = await comments(['t1', 't2'], 3);

    expect(
      rows.map(({ id, traceID, userNickname, replyToID, replyToNickname }) => ({
        id,
        traceID,
        userNickname,
        replyToID,
        replyToNickname,
      })),
    ).toEqual([
      {
        id: 'c-private',
        traceID: 't1',
        userNickname: 'nick-u4',
        replyToID: null,
        replyToNickname: null,
      },
      {
        id: 'c-reply',
        traceID: 't1',
        userNickname: 'nick-u3',
        replyToID: 'c-root',
        replyToNickname: 'nick-u1',
      },
      {
        id: 'c-img',
        traceID: 't1',
        userNickname: 'nick-u2',
        replyToID: null,
        replyToNickname: null,
      },
      {
        id: 'c-t2',
        traceID: 't2',
        userNickname: 'nick-u6',
        replyToID: 'c-img',
        replyToNickname: 'nick-u2',
      },
    ]);
    const image = rows.find((row) => row.id === 'c-img')!;
    expect(image.images).toEqual(['https://cdn.example/a.jpg']);
    expect(image.content).toBe('content-c-img');
    expect(image.userID).toBe('u2');
    expect(image.createdAt.toISOString()).toBe('2026-06-01T00:00:02.000Z');
  });

  it('reads a hot trace through the two preview indexes instead of all its rows', async () => {
    // 一条有 5000 个赞、600 条评论的热门动态，外加两条普通动态。
    await s.db.query(`
      INSERT INTO "traceLikeStat" (id, "traceID", "userID", deleted, "updatedAt")
      SELECT 'hl-' || g, 'hot', 'u' || g, g % 7 = 0,
             TIMESTAMP '2026-06-01' + (g || ' seconds')::interval
      FROM generate_series(1, 5000) g;
      INSERT INTO "TraceComment" (id, "traceID", "userID", deleted, "createdAt")
      SELECT 'hc-' || g, 'hot', 'u' || (g % 6000 + 1), g % 11 = 0,
             TIMESTAMP '2026-06-01' + (g || ' seconds')::interval
      FROM generate_series(1, 600) g;
      INSERT INTO "traceLikeStat" (id, "traceID", "userID", "updatedAt")
      SELECT 'l1-' || g, 't1', 'u' || g, TIMESTAMP '2026-06-01'
      FROM generate_series(1, 30) g;
      ANALYZE "traceLikeStat"; ANALYZE "TraceComment"; ANALYZE "User";
    `);

    const likeQuery = traceLikePreviewQuery(['hot', 't1'], 20);
    const commentQuery = traceCommentPreviewQuery(['hot', 't1'], 20);
    const likePlan = await explainPlan(s.db, likeQuery.text, likeQuery.values);
    const commentPlan = await explainPlan(
      s.db,
      commentQuery.text,
      commentQuery.values,
    );

    expect(likePlan).toContain('traceLikeStat_live_traceID_updatedAt_idx');
    expect(commentPlan).toContain('TraceComment_traceID_createdAt_idx');
    // 预览子查询（别名 stat / tc）是逐条动态的索引扫描 + LIMIT；父评论、作者昵称这些
    // 按主键补齐的小表 JOIN 在测试库里可能被选成哈希连接，与这里无关。
    for (const plan of [likePlan, commentPlan]) {
      expect(plan).toContain('"Node Type":"Limit"');
      expect(plan).not.toMatch(
        /"Node Type":"Seq Scan"[^}]*"Alias":"(stat|tc)"/,
      );
    }

    const hotLikes = (await likes(['hot'], 20)).map((row) => row.userID);
    expect(hotLikes).toHaveLength(20);
    // 最新的有效赞：u5000 往下，跳过 7 的倍数（软删）。
    expect(hotLikes.slice(0, 3)).toEqual(['u5000', 'u4999', 'u4997']);
    expect(await comments(['hot'], 20)).toHaveLength(20);
  });

  it('drops the TraceComment_traceID_idx prefix index the new one covers', async () => {
    const { rows } = await s.db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'TraceComment' ORDER BY indexname`,
      [s.schema],
    );
    expect(rows.map((row) => row.indexname)).toEqual([
      'TraceComment_pkey',
      'TraceComment_traceID_createdAt_idx',
      'TraceComment_userID_idx',
    ]);
  });
});
