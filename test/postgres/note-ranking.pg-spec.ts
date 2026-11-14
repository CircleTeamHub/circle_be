import { NoteService } from 'src/note/note.service';
import { noteRankingQuery } from 'src/note/note-ranking.query';
import { ratingCalendar } from 'src/note-rating/note-rating-calendar';
import { describePostgres, explainPlan } from './pg-test-db';
import { type LiveSchema, openLiveSchema, seedUsers } from './live-prisma';

/**
 * 大众点评月榜（GET /note/ranking）在真 PostgreSQL + 真 PrismaClient 上跑：表结构从
 * schema.prisma 现场生成（含 Note.city 和 (month, goodCount) 索引），排名 SQL 就是
 * service 里那一条（noteRankingQuery），再走真实的摘要读取与映射。
 *
 * - 资格：只收本月好评 > 0、ACTIVE + available、选了城市的原笔记；下架、隐藏、删除、
 *   收藏副本、没选城市、零好评、只有上月计数的都不上榜；
 * - 排序：好评降序 → 差评升序 → 最近更新 → id，LIMIT 在库里做；
 * - 按城市筛选；映射用请求者视角（他人的备注不外发）。
 */
jest.setTimeout(60_000);

const OWNER = 'owner';
const OTHER = 'other';
const VIEWER = 'viewer';

function previousMonthOf(month: string): string {
  const [year, value] = month.split('-').map(Number);
  return value === 1
    ? `${year - 1}-12`
    : `${year}-${String(value - 1).padStart(2, '0')}`;
}

describePostgres('note ranking on PostgreSQL', () => {
  let live: LiveSchema;
  let service: NoteService;
  const month = ratingCalendar(new Date()).month;

  async function note(
    id: string,
    fields: {
      ownerID?: string;
      city?: string | null;
      status?: 'ACTIVE' | 'UNLISTED' | 'DELETED';
      available?: boolean;
      collectedFromNoteID?: string;
      updatedAt?: string;
    },
    counters: Array<{ month: string; good: number; bad: number }>,
  ) {
    await live.db.query(
      `INSERT INTO "Note" (id, "ownerID", title, city, status, available, remark,
         "collectedFromNoteID", "rootSourceNoteID", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"NoteStatus", $6, 'owner only', $7, $7, $8)`,
      [
        id,
        fields.ownerID ?? OWNER,
        `title ${id}`,
        fields.city === undefined ? '上海' : fields.city,
        fields.status ?? 'ACTIVE',
        fields.available ?? true,
        fields.collectedFromNoteID ?? null,
        fields.updatedAt ?? '2026-01-01T00:00:00Z',
      ],
    );
    for (const counter of counters) {
      await live.db.query(
        `INSERT INTO "NoteRatingMonthly" ("noteID", month, "goodCount", "badCount")
         VALUES ($1, $2, $3, $4)`,
        [id, counter.month, counter.good, counter.bad],
      );
    }
  }
  const thisMonth = (good: number, bad: number) => [{ month, good, bad }];

  beforeAll(async () => {
    live = await openLiveSchema('note_ranking');
    service = new NoteService(
      live.prisma as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
      { createPresignedGetUrl: jest.fn() } as never,
    );
    await seedUsers(live.db, [OWNER, OTHER, VIEWER]);

    // ── 上榜 ────────────────────────────────────────────────────────────────
    await note('sh-top', {}, thisMonth(9, 3));
    await note('sh-tie-fewer-bad', { ownerID: OTHER }, thisMonth(5, 0));
    await note(
      'sh-tie-older',
      { updatedAt: '2026-01-01T00:00:00Z' },
      thisMonth(5, 2),
    );
    await note(
      'cd-tie-newer',
      { city: '成都', updatedAt: '2026-01-02T00:00:00Z' },
      thisMonth(5, 2),
    );
    // 好评、差评、更新时间全相同：按 id 决出先后。
    await note('cd-same-b', { city: '成都' }, thisMonth(3, 1));
    await note('cd-same-a', { city: '成都' }, thisMonth(3, 1));

    // ── 不上榜（每条好评都比上榜的多，漏掉任何一个过滤就会排到最前面）──────────
    await note('unavailable', { available: false }, thisMonth(20, 0));
    await note('unlisted', { status: 'UNLISTED' }, thisMonth(20, 0));
    await note('deleted', { status: 'DELETED' }, thisMonth(20, 0));
    await note(
      'collected-copy',
      { ownerID: VIEWER, collectedFromNoteID: 'sh-top' },
      thisMonth(20, 0),
    );
    await note('no-city', { city: null }, thisMonth(20, 0));
    await note('zero-good', {}, thisMonth(0, 5));
    await note('last-month', {}, [
      { month: previousMonthOf(month), good: 20, bad: 0 },
    ]);
  });

  afterAll(async () => {
    await live?.close();
  });

  const ids = async (city: string | null, limit = 50) =>
    (await service.getNoteRanking(VIEWER, { city, limit })).items.map(
      (item) => item.id,
    );

  it('ranks only eligible notes nationwide in a deterministic order', async () => {
    expect(await ids(null)).toEqual([
      'sh-top',
      'sh-tie-fewer-bad',
      'cd-tie-newer',
      'sh-tie-older',
      'cd-same-a',
      'cd-same-b',
    ]);
  });

  it('narrows the ranking to one city', async () => {
    expect(await ids('上海')).toEqual([
      'sh-top',
      'sh-tie-fewer-bad',
      'sh-tie-older',
    ]);
    expect(await ids('成都')).toEqual([
      'cd-tie-newer',
      'cd-same-a',
      'cd-same-b',
    ]);
    expect(await ids('北京')).toEqual([]);
  });

  it('applies the limit in the database', async () => {
    expect(await ids(null, 2)).toEqual(['sh-top', 'sh-tie-fewer-bad']);
    const { rows } = await live.db.query<{ id: string }>(
      noteRankingQuery({ month, city: null, limit: 1 }).text,
      noteRankingQuery({ month, city: null, limit: 1 }).values,
    );
    expect(rows).toEqual([{ id: 'sh-top' }]);
  });

  it('returns this month, the city and viewer-scoped summaries', async () => {
    const result = await service.getNoteRanking(VIEWER, {
      city: '上海',
      limit: 1,
    });

    expect(result.month).toBe(month);
    expect(result.city).toBe('上海');
    expect(result.items[0]).toMatchObject({
      id: 'sh-top',
      ownerId: OWNER,
      city: '上海',
      canEdit: false,
      remark: null,
      goodCount: 9,
      badCount: 3,
    });
    const [own] = (
      await service.getNoteRanking(OWNER, { city: '上海', limit: 1 })
    ).items;
    expect(own).toMatchObject({ canEdit: true, remark: 'owner only' });
  });

  it('can read the month straight off the (month, goodCount) index', async () => {
    const query = noteRankingQuery({ month, city: '上海', limit: 50 });
    await live.db.query('SET enable_seqscan = off');
    try {
      expect(await explainPlan(live.db, query.text, query.values)).toContain(
        'NoteRatingMonthly_month_goodCount_idx',
      );
    } finally {
      await live.db.query('RESET enable_seqscan');
    }
  });
});
