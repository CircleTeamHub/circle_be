import { NoteCleanup } from 'src/note/note-cleanup';
import {
  deletedNotesQuery,
  expiredUnlistedNotesQuery,
} from 'src/note/note-cleanup.query';
import { NOTE_UNLISTED_RETENTION_MS, NoteService } from 'src/note/note.service';
import { describePostgres, explainPlan } from './pg-test-db';
import {
  type LiveSchema,
  openLiveSchema,
  readMigration,
  seedUsers,
} from './live-prisma';

/**
 * 取消回收站后的笔记清理（NoteCleanup）与下架合并迁移，在真 PostgreSQL + 真 PrismaClient 上：
 * - 候选查询：DELETED 不论删了多久全取；UNLISTED 只取 unlistedAt <= now − 60×24h（边界两侧
 *   各差 1 毫秒）；上架的不碰；两条都落在迁移里的部分索引上；
 * - 整轮跑完：到期下架笔记先标 DELETED、排上状态广播，再和其它已删除笔记一起删行
 *   （媒体行随外键级联），下游收藏副本留着；
 * - 迁移 20261113130000 的数据改写：OFF_SHELF 的上架笔记转下架、旧标记清空、已下架的从部署时起算。
 */
jest.setTimeout(60_000);

const OWNER = 'owner';
const COLLECTOR = 'collector';
const NOW = new Date('2026-11-13T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - NOTE_UNLISTED_RETENTION_MS);
const ms = (offset: number) => new Date(CUTOFF.getTime() + offset);

/** 迁移文件里的一类语句（去注释、按分号切），照 Prisma 逐条执行的方式跑。 */
function migrationStatements(name: string, keep: RegExp): string[] {
  return readMigration(name)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => keep.test(statement));
}

describePostgres('note cleanup on PostgreSQL', () => {
  let live: LiveSchema;
  let cleanup: NoteCleanup;

  async function note(
    id: string,
    fields: {
      ownerID?: string;
      status: 'ACTIVE' | 'UNLISTED' | 'DELETED';
      workStatus?: 'WORKING' | 'CLOSED' | 'OFF_SHELF' | null;
      unlistedAt?: Date | null;
      updatedAt?: Date;
      collectedFromNoteID?: string;
    },
  ) {
    await live.db.query(
      `INSERT INTO "Note" (id, "ownerID", title, status, "workStatus", "unlistedAt",
         "collectedFromNoteID", "rootSourceNoteID", "updatedAt")
       VALUES ($1, $2, $1, $3::"NoteStatus", $4::"NoteWorkStatus", $5, $6, $6, $7)`,
      [
        id,
        fields.ownerID ?? OWNER,
        fields.status,
        fields.workStatus ?? null,
        fields.unlistedAt ?? null,
        fields.collectedFromNoteID ?? null,
        fields.updatedAt ?? NOW,
      ],
    );
  }
  const ids = async (sql: string, values: unknown[] = []) =>
    (await live.db.query<{ id: string }>(sql, values)).rows.map(
      (row) => row.id,
    );

  beforeAll(async () => {
    live = await openLiveSchema('note_cleanup');
    // 部分索引 schema.prisma 表达不了：照迁移原文建（CONCURRENTLY 单条执行）。
    for (const statement of [
      ...migrationStatements(
        '20261026000500_note_collect_chain_and_recycle_bin_indexes',
        /^CREATE INDEX/,
      ),
      ...migrationStatements(
        '20261113130000_note_unlisted_lifecycle',
        /^CREATE INDEX/,
      ),
    ]) {
      await live.db.query(statement);
    }
    const notes = new NoteService(
      live.prisma as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
    );
    cleanup = new NoteCleanup(live.prisma as never, notes);
    await seedUsers(live.db, [OWNER, COLLECTOR]);
  });

  afterAll(async () => {
    await live?.close();
  });

  beforeEach(async () => {
    await live.db.query(
      'TRUNCATE "NoteMedia", "NoteStatusFanoutOutbox", "Note" CASCADE',
    );
  });

  it('selects every deleted note and only 下架 notes at least 60 days old', async () => {
    await note('deleted-long-ago', {
      status: 'DELETED',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await note('deleted-just-now', { status: 'DELETED', updatedAt: NOW });
    await note('unlisted-past', { status: 'UNLISTED', unlistedAt: ms(-1) });
    await note('unlisted-exactly-60d', {
      status: 'UNLISTED',
      unlistedAt: ms(0),
    });
    await note('unlisted-1ms-short', { status: 'UNLISTED', unlistedAt: ms(1) });
    await note('active-ancient', {
      status: 'ACTIVE',
      updatedAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const expired = expiredUnlistedNotesQuery({
      unlistedBefore: CUTOFF,
      limit: 200,
    });
    const deleted = deletedNotesQuery({ limit: 200 });
    expect(await ids(expired.text, expired.values)).toEqual([
      'unlisted-past',
      'unlisted-exactly-60d',
    ]);
    expect(await ids(deleted.text, deleted.values)).toEqual([
      'deleted-long-ago',
      'deleted-just-now',
    ]);
  });

  it('pages expired 下架 notes by (unlistedAt, id) without gaps or repeats', async () => {
    for (const id of ['b', 'a', 'c']) {
      await note(id, { status: 'UNLISTED', unlistedAt: ms(-1000) });
    }
    await note('d', { status: 'UNLISTED', unlistedAt: ms(-10) });

    const pages: string[][] = [];
    let after: { at: Date; id: string } | undefined;
    for (;;) {
      const query = expiredUnlistedNotesQuery({
        unlistedBefore: CUTOFF,
        after,
        limit: 2,
      });
      const { rows } = await live.db.query<{ id: string; cursorAt: Date }>(
        query.text,
        query.values,
      );
      pages.push(rows.map((row) => row.id));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1];
      after = { at: last.cursorAt, id: last.id };
    }

    expect(pages).toEqual([['a', 'b'], ['c', 'd'], []]);
  });

  it('reads expired 下架 notes through the partial (unlistedAt, id) index', async () => {
    await live.db.query(`
      INSERT INTO "Note" (id, "ownerID", title, status, "unlistedAt", "updatedAt")
      SELECT 'filler-' || g, '${OWNER}', 't',
             CASE WHEN g % 10 = 0 THEN 'UNLISTED'::"NoteStatus" ELSE 'ACTIVE'::"NoteStatus" END,
             CASE WHEN g % 10 = 0 THEN now() END, now()
      FROM generate_series(1, 3000) g
    `);
    await live.db.query('ANALYZE "Note"');
    const query = expiredUnlistedNotesQuery({
      unlistedBefore: CUTOFF,
      after: { at: ms(-5), id: 'x' },
      limit: 200,
    });
    await live.db.query('SET enable_seqscan = off');
    try {
      expect(await explainPlan(live.db, query.text, query.values)).toContain(
        'Note_unlisted_unlistedAt_id_idx',
      );
    } finally {
      await live.db.query('RESET enable_seqscan');
    }
  });

  it('expires, fans out and purges in one run, leaving newer 下架 and on-shelf notes', async () => {
    await note('deleted-old', {
      status: 'DELETED',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await live.db.query(
      `INSERT INTO "NoteMedia" (id, "noteID", type, "objectKey", url, "sortOrder")
       VALUES ('media-1', 'deleted-old', 'IMAGE', 'notes/owner/a.jpg', 'https://x/a.jpg', 0)`,
    );
    await note('unlisted-expired', { status: 'UNLISTED', unlistedAt: ms(0) });
    await note('copy-of-expired', {
      ownerID: COLLECTOR,
      status: 'ACTIVE',
      collectedFromNoteID: 'unlisted-expired',
    });
    await note('unlisted-fresh', { status: 'UNLISTED', unlistedAt: ms(1) });
    await note('active', { status: 'ACTIVE' });

    await cleanup.sweep(NOW);

    expect(await ids(`SELECT id FROM "Note" ORDER BY id`)).toEqual([
      'active',
      'copy-of-expired',
      'unlisted-fresh',
    ]);
    expect(await ids(`SELECT id FROM "NoteMedia"`)).toEqual([]);
    // 收藏者与聊天卡片收到「已删除」：广播按根排队（根行没了，处理器按 DELETED 发）。
    expect(
      await ids(`SELECT "rootNoteID" AS id FROM "NoteStatusFanoutOutbox"`),
    ).toEqual(['unlisted-expired']);
    const { rows } = await live.db.query<{ unlistedAt: Date }>(
      `SELECT "unlistedAt" FROM "Note" WHERE id = 'unlisted-fresh'`,
    );
    expect(rows[0].unlistedAt).toEqual(ms(1));
  });

  it('migration 20261113130000 merges OFF_SHELF into 下架 and starts every 60 days at deploy', async () => {
    const before = new Date();
    const earlier = new Date('2026-10-01T00:00:00.000Z');
    await note('active-off-shelf', {
      status: 'ACTIVE',
      workStatus: 'OFF_SHELF',
    });
    await note('unlisted-off-shelf', {
      status: 'UNLISTED',
      workStatus: 'OFF_SHELF',
    });
    await note('unlisted-plain', { status: 'UNLISTED' });
    await note('unlisted-stamped', { status: 'UNLISTED', unlistedAt: earlier });
    await note('active-working', { status: 'ACTIVE', workStatus: 'WORKING' });
    await note('deleted-off-shelf', {
      status: 'DELETED',
      workStatus: 'OFF_SHELF',
    });

    for (const statement of migrationStatements(
      '20261113130000_note_unlisted_lifecycle',
      /^UPDATE/,
    )) {
      await live.db.query(statement);
    }

    const { rows } = await live.db.query<{
      id: string;
      status: string;
      workStatus: string | null;
      unlistedAt: Date | null;
    }>(`SELECT id, status, "workStatus", "unlistedAt" FROM "Note" ORDER BY id`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('active-off-shelf')).toMatchObject({
      status: 'UNLISTED',
      workStatus: null,
    });
    expect(byId.get('unlisted-off-shelf')).toMatchObject({
      status: 'UNLISTED',
      workStatus: null,
    });
    expect(byId.get('deleted-off-shelf')).toMatchObject({
      status: 'DELETED',
      workStatus: null,
    });
    expect(byId.get('active-working')).toMatchObject({
      status: 'ACTIVE',
      workStatus: 'WORKING',
      unlistedAt: null,
    });
    expect(byId.get('unlisted-stamped')?.unlistedAt).toEqual(earlier);
    for (const id of [
      'active-off-shelf',
      'unlisted-off-shelf',
      'unlisted-plain',
    ]) {
      const at = byId.get(id)?.unlistedAt;
      expect(at?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    }
    expect(byId.get('deleted-off-shelf')?.unlistedAt).toBeNull();
  });
});
