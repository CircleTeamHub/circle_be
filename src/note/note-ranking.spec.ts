import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { Prisma } from 'src/generated/prisma';
import { JwtGuard } from 'src/guards/jwt.guard';
import { IdempotencyService } from 'src/idempotency/idempotency.service';
import { NoteController } from './note.controller';
import { noteRankingQuery } from './note-ranking.query';
import { NoteService } from './note.service';

/**
 * 大众点评月榜。资格与排序在 noteRankingQuery 的 SQL 里，真库行为（各类排除、同分排序、
 * 上月不计）由 test/postgres/note-ranking.pg-spec.ts 跑；这里锁住 SQL 的形状、service
 * 的名次保持与视角映射，以及路由顺序和查询参数校验。
 */
describe('noteRankingQuery', () => {
  const flat = (query: Prisma.Sql) => query.text.replace(/\s+/g, ' ');

  it('keeps only ACTIVE, available source notes with a city and good ratings this month', () => {
    const query = noteRankingQuery({ month: '2026-11', city: null, limit: 50 });
    const sql = flat(query);

    expect(sql).toContain('FROM "NoteRatingMonthly" r JOIN "Note" n');
    expect(sql).toContain('r."month" = $1');
    expect(sql).toContain('r."goodCount" > 0');
    expect(sql).toContain(`n."status" = 'ACTIVE'`);
    expect(sql).toContain('n."available" = true');
    expect(sql).toContain('n."collectedFromNoteID" IS NULL');
    // 全国榜也只收选了城市的笔记。
    expect(sql).toContain('n."city" IS NOT NULL');
    expect(query.values).toEqual(['2026-11', 50]);
  });

  it('narrows to one city as a bound parameter', () => {
    const query = noteRankingQuery({
      month: '2026-11',
      city: '上海',
      limit: 10,
    });

    expect(flat(query)).toContain('n."city" = $2');
    expect(flat(query)).not.toContain('IS NOT NULL AND');
    expect(query.values).toEqual(['2026-11', '上海', 10]);
  });

  it('orders deterministically and limits in the database', () => {
    const sql = flat(
      noteRankingQuery({ month: '2026-11', city: null, limit: 5 }),
    );

    expect(sql).toContain(
      'ORDER BY r."goodCount" DESC, r."badCount" ASC, n."updatedAt" DESC, n."id" ASC LIMIT $2',
    );
  });
});

describe('NoteService.getNoteRanking', () => {
  const contact = { id: 'friend-1', name: '老王', faceURL: null };
  const summaryRow = (id: string, ownerID: string, city: string) => ({
    id,
    ownerID,
    title: `title ${id}`,
    status: 'ACTIVE',
    available: true,
    workStatus: 'WORKING',
    sourceConversationID: 'conv-1',
    pinned: true,
    remark: 'private remark',
    city,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    mediaCount: 0,
    collectedFrom: null,
    collectedFromNoteID: null,
    rootSourceNoteID: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    groupMemberships: [{ group: { id: 'g-1', name: 'Mine' } }],
  });
  const projection = (id: string) => ({
    id,
    contentHead: `content ${id}`,
    sectionTextHasText: null,
    hasJsonText: false,
    showcaseCount: 0,
    contactItems: [contact],
    groupItems: null,
    hasLocation: true,
    coverId: null,
    coverType: null,
    coverUrl: null,
    coverObjectKey: null,
    coverNoteID: null,
  });

  function fixture(ranked: string[]) {
    const rows = [
      summaryRow('note-a', 'owner-a', '上海'),
      summaryRow('note-b', 'viewer', '上海'),
      summaryRow('note-c', 'owner-c', '上海'),
    ];
    const prisma = {
      $queryRaw: jest.fn(async (query: Prisma.Sql) =>
        query.sql.includes('"NoteRatingMonthly"')
          ? ranked.map((id) => ({ id }))
          : (query.values.find(Array.isArray) as string[]).map(projection),
      ),
      note: {
        // 故意乱序返回：名次只能来自排名查询。
        findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
          rows.filter((row) => args.where.id.in.includes(row.id)).reverse(),
        ),
      },
      noteRatingMonthly: {
        findMany: jest.fn().mockResolvedValue([
          { noteID: 'note-a', goodCount: 9, badCount: 1 },
          { noteID: 'note-b', goodCount: 4, badCount: 0 },
        ]),
      },
      circle: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new NoteService(
      prisma as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
      { createPresignedGetUrl: jest.fn() } as never,
    );
    return { service, prisma };
  }

  afterEach(() => jest.useRealTimers());

  it('ranks the current Shanghai month and keeps the database order', async () => {
    // UTC 11-30 16:30 已是上海 12-01：榜单换到新的月份。
    jest.useFakeTimers({ now: Date.parse('2026-11-30T16:30:00.000Z') });
    const { service, prisma } = fixture(['note-b', 'note-a', 'gone']);

    const result = await service.getNoteRanking('viewer', {
      city: '上海',
      limit: 3,
    });

    const [rankingQuery] = prisma.$queryRaw.mock.calls[0];
    expect(rankingQuery.values).toEqual(['2026-12', '上海', 3]);
    expect(prisma.noteRatingMonthly.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { noteID: { in: ['note-b', 'note-a'] }, month: '2026-12' },
      }),
    );
    expect(result.month).toBe('2026-12');
    expect(result.city).toBe('上海');
    // 两次读取之间被永久删除的 'gone' 直接少一名。
    expect(result.items.map((item) => item.id)).toEqual(['note-b', 'note-a']);
  });

  it('maps every item as the requesting viewer sees it', async () => {
    const { service } = fixture(['note-a', 'note-b']);

    const { items } = await service.getNoteRanking('viewer', { limit: 50 });
    const [other, own] = items;

    expect(other).toMatchObject({
      id: 'note-a',
      city: '上海',
      canEdit: false,
      remark: null,
      pinned: false,
      groups: [],
      sourceConversationID: null,
      contactCount: 0,
      cardPreview: { contacts: [], groups: [] },
      goodCount: 9,
      badCount: 1,
    });
    expect(own).toMatchObject({
      id: 'note-b',
      city: '上海',
      canEdit: true,
      remark: 'private remark',
      contactCount: 1,
      cardPreview: { contacts: [{ id: 'friend-1', name: '老王' }] },
      goodCount: 4,
      badCount: 0,
    });
  });

  it('reports the nationwide list as city null and skips the reads when nothing is ranked', async () => {
    const { service, prisma } = fixture([]);

    const result = await service.getNoteRanking('viewer', { limit: 50 });

    expect(result).toEqual({
      month: expect.stringMatching(/^\d{4}-\d{2}$/),
      city: null,
      items: [],
    });
    expect(prisma.$queryRaw.mock.calls[0][0].values).toHaveLength(2);
    expect(prisma.note.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /note/ranking', () => {
  let app: INestApplication;
  let baseUrl: string;
  const noteService = {
    getNoteRanking: jest.fn(),
    getNote: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ limit: 1000, ttl: 60_000 }])],
      controllers: [NoteController],
      providers: [
        { provide: IdempotencyService, useValue: {} },
        { provide: NoteService, useValue: noteService },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    // 与 setup.ts 的全局管道同一套选项：查询参数的转换和校验都要走到。
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    noteService.getNoteRanking.mockResolvedValue({
      month: '2026-11',
      city: null,
      items: [],
    });
  });

  it('is not swallowed by GET /note/:id and defaults to the nationwide top 50', async () => {
    const res = await fetch(`${baseUrl}/note/ranking`);

    expect(res.status).toBe(200);
    expect(noteService.getNote).not.toHaveBeenCalled();
    expect(noteService.getNoteRanking).toHaveBeenCalledWith('user-1', {
      limit: 50,
    });
  });

  it('passes a trimmed city and a numeric limit to the service', async () => {
    const res = await fetch(
      `${baseUrl}/note/ranking?city=${encodeURIComponent(' 上海 ')}&limit=10`,
    );

    expect(res.status).toBe(200);
    expect(noteService.getNoteRanking).toHaveBeenCalledWith('user-1', {
      city: '上海',
      limit: 10,
    });
  });

  it('treats an empty city as nationwide', async () => {
    await fetch(`${baseUrl}/note/ranking?city=`);

    expect(noteService.getNoteRanking).toHaveBeenCalledWith('user-1', {
      city: null,
      limit: 50,
    });
  });

  it.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=abc'],
    [`city=${'x'.repeat(33)}`],
    ['sort=bad'],
  ])('rejects ?%s with 400', async (query) => {
    const res = await fetch(`${baseUrl}/note/ranking?${query}`);

    expect(res.status).toBe(400);
    expect(noteService.getNoteRanking).not.toHaveBeenCalled();
  });
});
