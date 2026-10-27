import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import type { PrivacySettingsDto } from 'src/privacy/privacy-settings.dto';
import { encodeTraceCursor, TraceService } from 'src/trace/trace.service';
import { traceFeedPageQuery } from 'src/trace/trace-feed.query';
import { feedCursorWhere, type FeedCursor } from 'src/utils/feed-cursor';
import {
  describePostgres,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * 朋友圈 feed 主查询改成「每个作者 LATERAL 取前 N 条再合并」后，在真 PostgreSQL 上
 * 与原查询逐行对照：
 * - 原逻辑（两次 Friend 读取 + IN 列表的 trace.findMany，照抄改造前的代码）与新的
 *   TraceService.getFeed 跑在同一份数据上：多个作者、同一时刻的并列行、跨页翻页、
 *   各种可见性 / 好友授权 / 隐私设置组合，游标模式与老客户端的页码模式（含 count）
 *   每一页的 id、hasMore、nextCursor、total 都要一致；
 * - 新服务走真的 PrismaClient + adapter-pg（$queryRaw 的 Date / 数组参数序列化、按 id
 *   回填整行都是真实路径），不是 mock；
 * - EXPLAIN：每个作者走 Trace_fromID_createdAt_id_idx 的有限扫描，没有对全量匹配行的
 *   Sort；翻到中间页时读的数据页比原查询少一个数量级。
 */
const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;

/** 原 getFeed 用的可见性 OR，照抄改造前的代码。 */
function oldWhere(
  viewerId: string,
  scope: { authorId: string } | { authorIds: string[] },
  cursor: FeedCursor | null,
) {
  const whereBase = {
    deleted: false,
    fromID: 'authorId' in scope ? scope.authorId : { in: scope.authorIds },
    OR: [
      { fromID: viewerId },
      { visibility: 'FRIENDS_ONLY' as const },
      { visibility: 'PUBLIC' as const },
    ],
  };
  return cursor ? { AND: [whereBase, feedCursorWhere(cursor)] } : whereBase;
}

/** 一个确定性的伪随机数（mulberry32），数据可复现。 */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describePostgres('trace feed lateral page (PostgreSQL)', () => {
  let s: IsolatedSchema;
  let prisma: PrismaClient;
  let service: TraceService;
  const capture = capturePrisma();

  const settings = new Map<string, PrivacySettingsDto>();
  const privacy = {
    getSettingsMany: (ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) =>
            settings.has(id) ? [[id, settings.get(id)!] as const] : [],
          ),
        ),
      ),
    momentsVisibleFor: (
      value: PrivacySettingsDto | undefined,
      isSelf: boolean,
      isFriend: boolean,
    ) =>
      PrivacySettingsService.prototype.momentsVisibleFor.call(
        undefined,
        value,
        isSelf,
        isFriend,
      ),
  };

  /** 改造前 getAcceptedFriendIds + filterMomentVisibleAuthorIds（含 getChatOnlyAuthorIdsToward）。 */
  const oldVisibleAuthors = async (viewerId: string) => {
    const records = await prisma.friend.findMany({
      where: {
        OR: [{ userID: viewerId }, { friendID: viewerId }],
        state: 'ACCEPTED',
      },
      select: { userID: true, friendID: true },
      orderBy: { updatedAt: 'desc' },
      take: 5_000,
    });
    const friendIds = records.map((r) =>
      r.userID === viewerId ? r.friendID : r.userID,
    );
    const friendIdSet = new Set(friendIds);
    const authorIds = [viewerId, ...friendIds];
    const others = authorIds.filter((id) => id !== viewerId);
    const chatOnly = new Set<string>();
    if (others.length > 0) {
      const rows = await prisma.friend.findMany({
        where: {
          state: 'ACCEPTED',
          OR: [
            { userID: { in: others }, friendID: viewerId },
            { userID: viewerId, friendID: { in: others } },
          ],
        },
        select: {
          userID: true,
          friendID: true,
          permissionA: true,
          permissionB: true,
        },
      });
      for (const record of rows) {
        if (record.userID === viewerId) {
          if (record.permissionB === 'CHAT_ONLY') chatOnly.add(record.friendID);
        } else if (record.permissionA === 'CHAT_ONLY') {
          chatOnly.add(record.userID);
        }
      }
    }
    const settingsByAuthor = await privacy.getSettingsMany(authorIds);
    return authorIds.filter(
      (authorId) =>
        !chatOnly.has(authorId) &&
        privacy.momentsVisibleFor(
          settingsByAuthor.get(authorId),
          authorId === viewerId,
          friendIdSet.has(authorId),
        ),
    );
  };

  type PageResult = {
    ids: string[];
    total: number | null;
    hasMore: boolean;
    nextCursor: string | null;
  };

  /** 改造前 getFeed 的分页部分（findMany + count + hasMore / nextCursor）。 */
  const oldPage = async (
    viewerId: string,
    scope: { authorId: string } | { authorIds: string[] },
    query: { page?: number; limit: number; cursor?: FeedCursor },
  ): Promise<PageResult> => {
    const { limit } = query;
    const cursor = query.cursor ?? null;
    const useKeyset = cursor !== null;
    const skip = useKeyset ? 0 : ((query.page ?? 1) - 1) * limit;
    const where = oldWhere(viewerId, scope, cursor);
    const rows = await prisma.trace.findMany({
      where,
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(useKeyset ? { take: limit + 1 } : { skip, take: limit }),
    });
    const total = useKeyset ? null : await prisma.trace.count({ where });
    const hasMore = useKeyset
      ? rows.length > limit
      : skip + rows.length < (total ?? 0);
    const traces = useKeyset ? rows.slice(0, limit) : rows;
    const last = traces[traces.length - 1];
    return {
      ids: traces.map((row) => row.id),
      total,
      hasMore,
      nextCursor:
        hasMore && last ? encodeTraceCursor(last.createdAt, last.id) : null,
    };
  };

  const newPage = async (
    viewerId: string,
    query: { page?: number; limit: number; cursor?: string; authorId?: string },
  ): Promise<PageResult> => {
    const result = await service.getFeed(viewerId, query);
    return {
      ids: result.items.map((item) => item.id),
      total: result.total,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    };
  };

  const decode = (cursor: string): FeedCursor => {
    const [iso, id] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    return { createdAt: new Date(iso), id };
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('trace_feed');
    await s.db.query(`
      CREATE TYPE "TraceVisibility" AS ENUM ('PRIVATE', 'PUBLIC', 'FRIENDS_ONLY');
      CREATE TYPE "TraceType" AS ENUM ('MOMENT');
      CREATE TYPE "FriendState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
      CREATE TYPE "FriendPermission" AS ENUM ('FULL', 'CHAT_ONLY');
      CREATE TABLE "User" (
        id text PRIMARY KEY,
        nickname text NOT NULL,
        "avatarUrl" text,
        "vipLevel" integer NOT NULL DEFAULT 0,
        "vipExpiresAt" timestamp(3)
      );
      CREATE TABLE "Friend" (
        id text PRIMARY KEY,
        "userID" text NOT NULL,
        "friendID" text NOT NULL,
        state "FriendState" NOT NULL DEFAULT 'PENDING',
        "permissionA" "FriendPermission" NOT NULL DEFAULT 'FULL',
        "permissionB" "FriendPermission" NOT NULL DEFAULT 'FULL',
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "Friend_userID_friendID_idx" ON "Friend" ("userID", "friendID");
      CREATE INDEX "Friend_friendID_userID_idx" ON "Friend" ("friendID", "userID");
      CREATE TABLE "Trace" (
        id text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        content text NOT NULL DEFAULT '',
        deleted boolean NOT NULL DEFAULT false,
        visibility "TraceVisibility" NOT NULL DEFAULT 'PUBLIC',
        images text[] NOT NULL DEFAULT '{}',
        type "TraceType" NOT NULL DEFAULT 'MOMENT',
        "fromID" text NOT NULL,
        "likeCount" integer NOT NULL DEFAULT 0,
        "replyCount" integer NOT NULL DEFAULT 0,
        "shareCount" integer NOT NULL DEFAULT 0,
        "viewCount" integer NOT NULL DEFAULT 0,
        latitude double precision,
        longitude double precision,
        "createdAt" timestamp(3) NOT NULL,
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE TABLE "traceLikeStat" (
        id text PRIMARY KEY,
        "traceID" text NOT NULL,
        "userID" text NOT NULL,
        deleted boolean NOT NULL DEFAULT false,
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE TABLE "TraceComment" (
        id text PRIMARY KEY,
        content text NOT NULL DEFAULT '',
        images text[] NOT NULL DEFAULT '{}',
        deleted boolean NOT NULL DEFAULT false,
        "traceID" text NOT NULL,
        "userID" text NOT NULL,
        "replyToID" text,
        "createdAt" timestamp(3) NOT NULL
      );
    `);
    // feed 依赖的索引照迁移原文建，改迁移会被这里拦住。
    const feedIndex = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260704083000_harden_note_collect_and_feed_indexes/migration.sql',
      ),
      'utf8',
    )
      .replace(/--.*$/gm, '')
      .split(';')
      .map((statement) => statement.trim())
      .find((statement) =>
        statement.startsWith(
          'CREATE INDEX IF NOT EXISTS "Trace_fromID_createdAt_id_idx"',
        ),
      );
    expect(feedIndex).toBeDefined();
    await s.db.query(feedIndex!);

    prisma = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: databaseUrl,
          options: `-c search_path="${s.schema}",public`,
        },
        { schema: s.schema },
      ),
    });
    service = new TraceService(
      prisma as unknown as PrismaService,
      { get: () => null } as unknown as ConfigService,
      {} as never,
      {} as never,
      privacy as never,
      { resolvePublicAppearances: () => Promise.resolve(new Map()) } as never,
    );

    // ── 小数据集：对照用 ──────────────────────────────────────────────────
    const users = [
      'v',
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
      'f6',
      'f7',
      'f8',
      'f9',
      'stranger',
    ];
    await s.db.query(
      `INSERT INTO "User" (id, nickname) SELECT u, 'nick-' || u FROM unnest($1::text[]) u`,
      [users],
    );
    const friend = (
      id: string,
      userID: string,
      friendID: string,
      extra: {
        state?: string;
        permissionA?: string;
        permissionB?: string;
        updatedAt?: string;
      } = {},
    ) =>
      s.db.query(
        `INSERT INTO "Friend" (id, "userID", "friendID", state, "permissionA", "permissionB", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          userID,
          friendID,
          extra.state ?? 'ACCEPTED',
          extra.permissionA ?? 'FULL',
          extra.permissionB ?? 'FULL',
          extra.updatedAt ?? '2026-05-01 00:00:00',
        ],
      );
    await friend('fr1', 'v', 'f1');
    await friend('fr2', 'f2', 'v');
    // f3 只给 viewer CHAT_ONLY（viewer 在 userID 一侧，看 permissionB）→ 隐藏。
    await friend('fr3', 'v', 'f3', { permissionB: 'CHAT_ONLY' });
    // f4 只给 viewer CHAT_ONLY（viewer 在 friendID 一侧，看 permissionA）→ 隐藏。
    await friend('fr4', 'f4', 'v', { permissionA: 'CHAT_ONLY' });
    // viewer 自己只给 f5 CHAT_ONLY：不影响 viewer 看 f5。
    await friend('fr5', 'v', 'f5', { permissionA: 'CHAT_ONLY' });
    // 重复的一对关系行，任一行 CHAT_ONLY 就隐藏。
    await friend('fr6a', 'v', 'f6', { updatedAt: '2026-05-03 00:00:00' });
    await friend('fr6b', 'f6', 'v', {
      permissionA: 'CHAT_ONLY',
      updatedAt: '2026-04-01 00:00:00',
    });
    await friend('fr7', 'v', 'f7', { state: 'PENDING' });
    // f8 的朋友圈设置对谁都不可见。
    await friend('fr8', 'f8', 'v');
    settings.set('f8', { momentsVisibility: 'PRIVATE' } as PrivacySettingsDto);
    // f9 只对好友可见：viewer 是好友，可见。
    await friend('fr9', 'v', 'f9');
    settings.set('f9', {
      momentsVisibility: 'FRIENDS_ONLY',
    } as PrivacySettingsDto);
    // 自己加自己的脏行。
    await friend('fr-self', 'v', 'v');

    // 每个作者 24 条动态，时间只从 6 个时刻里挑 —— 大量同一时刻的并列行，
    // 跨作者、同作者都有，次序全靠 id 决出。
    const random = rng(20261026);
    const visibilities = ['PRIVATE', 'FRIENDS_ONLY', 'PUBLIC'];
    const traceRows: unknown[][] = [];
    for (const author of users) {
      for (let i = 0; i < 24; i += 1) {
        const second = Math.floor(random() * 6);
        traceRows.push([
          `t-${Math.floor(random() * 1e9)
            .toString(36)
            .padStart(6, '0')}-${author}-${i}`,
          author,
          visibilities[Math.floor(random() * 3)],
          random() < 0.15,
          `2026-06-01 00:00:0${second}.${second === 3 ? '500' : '000'}`,
        ]);
      }
    }
    for (const row of traceRows) {
      await s.db.query(
        `INSERT INTO "Trace" (id, "fromID", visibility, deleted, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $5)`,
        row,
      );
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await s?.close();
  });

  it('builds the same visible author scope from one Friend read', async () => {
    const old = await oldVisibleAuthors('v');
    const scope = await (
      service as unknown as {
        loadMomentFriendScope: (
          viewerId: string,
        ) => Promise<{ friendIds: string[]; chatOnlyIds: Set<string> }>;
      }
    ).loadMomentFriendScope('v');
    const visible = await (
      service as unknown as {
        filterMomentVisibleAuthorIds: (
          viewerId: string,
          authorIds: string[],
          friendIdSet: Set<string>,
          chatOnlyIds: Set<string>,
        ) => Promise<string[]>;
      }
    ).filterMomentVisibleAuthorIds(
      'v',
      ['v', ...scope.friendIds],
      new Set(scope.friendIds),
      scope.chatOnlyIds,
    );

    expect([...visible].sort()).toEqual([...old].sort());
    // 不只是两边都空：f3 / f4 / f6 被 CHAT_ONLY 挡掉，f8 被隐私设置挡掉，f7 不是好友。
    expect(new Set(old)).toEqual(new Set(['v', 'f1', 'f2', 'f5', 'f9']));
  });

  it('returns identical offset pages, totals and cursors for the whole feed', async () => {
    const authorIds = await oldVisibleAuthors('v');
    let page = 1;
    let sawTieAcrossPages = false;
    let previousLast: string | null = null;
    for (;;) {
      const expected = await oldPage('v', { authorIds }, { page, limit: 7 });
      const actual = await newPage('v', { page, limit: 7 });
      expect(actual).toEqual(expected);
      if (previousLast && expected.ids[0]) {
        const [a, b] = await Promise.all(
          [previousLast, expected.ids[0]].map((id) =>
            prisma.trace.findUniqueOrThrow({
              where: { id },
              select: { createdAt: true },
            }),
          ),
        );
        if (a.createdAt.getTime() === b.createdAt.getTime()) {
          sawTieAcrossPages = true;
        }
      }
      previousLast = expected.ids[expected.ids.length - 1] ?? null;
      if (!expected.hasMore) break;
      page += 1;
    }
    expect(page).toBeGreaterThan(5);
    // 有页边界正好切在同一时刻的并列行中间，id 次序被真正考到了。
    expect(sawTieAcrossPages).toBe(true);
    // 越过末页：空页、hasMore=false，两边一样。
    expect(await newPage('v', { page: page + 1, limit: 7 })).toEqual(
      await oldPage('v', { authorIds }, { page: page + 1, limit: 7 }),
    );
  });

  it('returns identical keyset pages when following nextCursor to the end', async () => {
    const authorIds = await oldVisibleAuthors('v');
    const first = await oldPage('v', { authorIds }, { page: 1, limit: 5 });
    expect(await newPage('v', { page: 1, limit: 5 })).toEqual(first);

    let cursor = first.nextCursor;
    let pages = 0;
    const seen = new Set(first.ids);
    while (cursor) {
      const expected = await oldPage(
        'v',
        { authorIds },
        { limit: 5, cursor: decode(cursor) },
      );
      const actual = await newPage('v', { limit: 5, cursor });
      expect(actual).toEqual(expected);
      for (const id of actual.ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      cursor = actual.nextCursor;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(8);
    expect(seen.size).toBe(
      await prisma.trace.count({ where: oldWhere('v', { authorIds }, null) }),
    );
  });

  it('returns identical album pages for a friend and for the viewer', async () => {
    for (const authorId of ['f1', 'v']) {
      const first = await oldPage('v', { authorId }, { page: 1, limit: 4 });
      expect(await newPage('v', { page: 1, limit: 4, authorId })).toEqual(
        first,
      );
      const second = await oldPage('v', { authorId }, { page: 2, limit: 4 });
      expect(await newPage('v', { page: 2, limit: 4, authorId })).toEqual(
        second,
      );
      let cursor = first.nextCursor;
      while (cursor) {
        const expected = await oldPage(
          'v',
          { authorId },
          { limit: 4, cursor: decode(cursor) },
        );
        const actual = await newPage('v', { limit: 4, cursor, authorId });
        expect(actual).toEqual(expected);
        cursor = actual.nextCursor;
      }
    }
  });

  it('reads each author through the feed index instead of sorting every matching row', async () => {
    // 120 个好友、每人 400 条动态（另有 1000 个不相干作者的动态穿插在同一批数据页里）；
    // viewer 翻到中间某页。
    await s.db.query(`
      INSERT INTO "User" (id, nickname)
      SELECT 'big-' || g, 'nick' FROM generate_series(0, 1120) g;
      INSERT INTO "Trace" (id, "fromID", visibility, deleted, content, "createdAt", "updatedAt")
      SELECT 'bt-' || a || '-' || i, 'big-' || a,
             (CASE WHEN i % 5 = 0 THEN 'PRIVATE' ELSE 'FRIENDS_ONLY' END)::"TraceVisibility",
             i % 17 = 0,
             repeat('x', 120),
             TIMESTAMP '2026-01-01' + ((i * 1121 + a) || ' seconds')::interval,
             TIMESTAMP '2026-01-01'
      FROM generate_series(1, 400) i, generate_series(1, 120) a;
      INSERT INTO "Trace" (id, "fromID", visibility, content, "createdAt", "updatedAt")
      SELECT 'other-' || a || '-' || i, 'big-' || a, 'FRIENDS_ONLY', repeat('x', 120),
             TIMESTAMP '2026-01-01' + ((i * 1121 + a) || ' seconds')::interval,
             TIMESTAMP '2026-01-01'
      FROM generate_series(1, 30) i, generate_series(121, 1120) a;
      ANALYZE "Trace";
    `);
    const authorIds = [
      'big-0',
      ...Array.from({ length: 120 }, (_, i) => `big-${i + 1}`),
    ];
    // 游标落在中间：所有可见动态按序的第 6000 条之后。
    const [middle] = await prisma.trace.findMany({
      where: oldWhere('big-0', { authorIds }, null),
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 6000,
      take: 1,
    });
    const cursor = { createdAt: middle.createdAt, id: middle.id };

    const [oldQuery] = await captureQueries(capture.queries, () =>
      capture.prisma.trace.findMany({
        where: oldWhere('big-0', { authorIds }, cursor),
        include: { from: { select: { id: true, nickname: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    const newQuery = traceFeedPageQuery({
      viewerId: 'big-0',
      authorIds,
      cursor,
      offset: 0,
      take: 21,
    });

    type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
    const analyze = async (sql: string, values: unknown[]) => {
      const result = await s.db.query<{
        'QUERY PLAN': [{ Plan: PlanNode }];
      }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
      return result.rows[0]['QUERY PLAN'][0].Plan;
    };
    const walk = (
      node: PlanNode,
      visit: (node: PlanNode, parents: PlanNode[]) => void,
      parents: PlanNode[] = [],
    ) => {
      visit(node, parents);
      for (const child of node.Plans ?? []) {
        walk(child, visit, [...parents, node]);
      }
    };
    /** 从 Trace 表读过的行（含被 Filter 丢掉的），乘以循环次数。 */
    const traceRowsRead = (plan: PlanNode) => {
      let rows = 0;
      walk(plan, (node) => {
        if (node['Relation Name'] !== 'Trace') return;
        const loops = Number(node['Actual Loops'] ?? 1);
        rows +=
          (Number(node['Actual Rows'] ?? 0) +
            Number(node['Rows Removed by Filter'] ?? 0) +
            Number(node['Rows Removed by Index Recheck'] ?? 0)) *
          loops;
      });
      return rows;
    };
    /** 直接排 Trace 扫描结果的 Sort（即对全部匹配行的 Top-N 排序）的输入行数。 */
    const sortedTraceRows = (plan: PlanNode) => {
      let rows = 0;
      walk(plan, (node) => {
        if (node['Node Type'] !== 'Sort') return;
        for (const child of node.Plans ?? []) {
          if (child['Relation Name'] === 'Trace') {
            rows += Number(child['Actual Rows'] ?? 0);
          }
        }
      });
      return rows;
    };

    // 并行计划里每个节点的 Actual Rows 是按 worker 平均的，行数对比要串行计划。
    await s.db.query('SET max_parallel_workers_per_gather = 0');
    const before = await analyze(oldQuery.sql, oldQuery.args);
    const after = await analyze(newQuery.text, newQuery.values);
    await s.db.query('RESET max_parallel_workers_per_gather');

    // 新计划：每个作者一次 Limit → Index Scan(Trace_fromID_createdAt_id_idx)，游标在
    // 索引条件里（从游标处开始扫，不是从头读再过滤）；唯一的 Sort 只排「作者数 × 21」
    // 行，不直接排 Trace 的扫描结果。
    const scans: Array<{ node: PlanNode; parents: PlanNode[] }> = [];
    walk(after, (node, parents) => {
      if (node['Relation Name'] === 'Trace') scans.push({ node, parents });
    });
    expect(scans).toHaveLength(1);
    const [{ node: scan, parents }] = scans;
    expect(scan['Node Type']).toBe('Index Scan');
    expect(scan['Index Name']).toBe('Trace_fromID_createdAt_id_idx');
    expect(String(scan['Index Cond'])).toMatch(/ROW\("createdAt", id\) </);
    expect(parents[parents.length - 1]['Node Type']).toBe('Limit');
    expect(scan['Actual Loops']).toBe(authorIds.length);
    expect(sortedTraceRows(after)).toBe(0);
    // 每个作者最多读 21 行加上被可见性过滤掉的几行。
    expect(traceRowsRead(after)).toBeLessThan(authorIds.length * 40);

    // 原计划：把 120 个作者的全部候选动态读出来，整体排序后取 21 行。
    expect(sortedTraceRows(before)).toBeGreaterThan(20_000);
    expect(traceRowsRead(after) * 5).toBeLessThan(traceRowsRead(before));

    // 同一个游标两边给出同一页。
    const oldRows = await prisma.trace.findMany({
      where: oldWhere('big-0', { authorIds }, cursor),
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
    const newRows = await s.db.query<{ id: string }>(
      newQuery.text,
      newQuery.values,
    );
    expect(newRows.rows.map((row) => row.id)).toEqual(
      oldRows.map((row) => row.id),
    );
  }, 120_000);
});
