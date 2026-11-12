import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { NoteRatingService, groupCardsOf } from './note-rating.service';

const OWNER = 'owner-1';
const RATER = 'rater-1';
const ROOT = 'root-note';
const COPY = 'rater-copy';
// 2026-11-11 12:00 in Shanghai.
const NOW = new Date('2026-11-11T04:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Card = Record<string, unknown>;

function sqlOf(call: unknown[]): Prisma.Sql {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
}

function setup(
  over: {
    cards?: Card[];
    hasCopy?: boolean;
    circleMember?: boolean;
    seat?: boolean;
    creditScore?: number;
    registeredAt?: Date;
    ratedToday?: boolean;
    lastOnNote?: Date | null;
    peers?: Array<Record<string, unknown>>;
    openBurstCase?: string | null;
    dailySlot?: boolean;
    monthly?: { goodCount: number; badCount: number } | null;
    daily?: { goodCount: number; badCount: number } | null;
  } = {},
) {
  const state = {
    cards: over.cards ?? [
      { id: 'conv-1', name: 'G', conversationID: 'conv-1' },
    ],
    hasCopy: over.hasCopy ?? true,
    creditScore: over.creditScore ?? 100,
    registeredAt: over.registeredAt ?? new Date(NOW.getTime() - 30 * DAY),
  };
  const calls: string[] = [];
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $executeRaw: jest.fn(async (...call: unknown[]) => {
      calls.push(sqlOf(call).sql);
      return 1;
    }),
    $queryRaw: jest.fn(async (...call: unknown[]) => {
      calls.push(sqlOf(call).sql);
      return (over.dailySlot ?? true) ? [{ noteID: ROOT }] : [];
    }),
    note: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => {
        if (where.rootSourceNoteID) return state.hasCopy ? { id: COPY } : null;
        if (where.id === COPY) return { id: COPY, rootSourceNoteID: ROOT };
        if (where.id === ROOT) {
          return {
            id: ROOT,
            rootSourceNoteID: null,
            ownerID: OWNER,
            sections: { groups: { items: state.cards } },
          };
        }
        return null;
      }),
    },
    user: {
      findUnique: jest.fn(async () => ({
        creditScore: state.creditScore,
        createdAt: state.registeredAt,
      })),
    },
    circle: {
      findFirst: jest.fn(async () => (over.circleMember ? { id: 'c' } : null)),
    },
    chatMember: {
      findFirst: jest.fn(async () =>
        (over.seat ?? true) ? { id: 's' } : null,
      ),
    },
    noteRating: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, any> }) => {
        if (where.noteID) {
          return over.lastOnNote ? { createdAt: over.lastOnNote } : null;
        }
        return over.ratedToday ? { id: 'earlier' } : null;
      }),
      findMany: jest.fn(async () => over.peers ?? []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-rating',
        noteID: data.noteID,
        value: data.value,
        status: data.status,
        ratedDay: data.ratedDay,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    noteRatingMonthly: {
      findMany: jest.fn(async () =>
        over.monthly ? [{ noteID: ROOT, ...over.monthly }] : [],
      ),
    },
    noteRatingDaily: {
      findUnique: jest.fn(async () => over.daily ?? null),
    },
    noteRatingCase: {
      findFirst: jest.fn(async () =>
        over.openBurstCase ? { id: over.openBurstCase } : null,
      ),
      create: jest.fn(async () => ({ id: 'case-new' })),
    },
    noteRatingCaseItem: { createMany: jest.fn(async () => ({ count: 3 })) },
  };
  const service = new NoteRatingService(prisma as never);
  return { service, prisma, calls };
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (caught: unknown) => caught,
  );
  return error as { getResponse: () => any; constructor: unknown };
}

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW.getTime(),
    doNotFake: ['nextTick', 'setImmediate'],
  });
});
afterEach(() => jest.useRealTimers());

describe('NoteRatingService.rate', () => {
  it('records a good rating on the root of the collect chain and counts it', async () => {
    const { service, prisma, calls } = setup({
      monthly: { goodCount: 3, badCount: 1 },
    });

    const result = await service.rate(RATER, COPY, { value: 'GOOD' });

    expect(prisma.noteRating.create).toHaveBeenCalledWith({
      data: {
        noteID: ROOT,
        ownerID: OWNER,
        raterID: RATER,
        value: 'GOOD',
        reason: null,
        comment: null,
        status: 'COUNTED',
        ratedDay: new Date('2026-11-11T00:00:00.000Z'),
        createdAt: NOW,
      },
      select: expect.any(Object),
    });
    expect(result).toEqual({
      noteId: ROOT,
      month: '2026-11',
      goodCount: 3,
      badCount: 1,
      ratingId: 'new-rating',
      status: 'COUNTED',
      nextRatableAt: new Date(NOW.getTime() + 72 * HOUR),
    });
    // Rater lock, owner lock, then the capped daily slot and the month row.
    expect(calls[0]).toContain('pg_advisory_xact_lock');
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([
      `note_rating:rater:${RATER}`,
    ]);
    expect(prisma.$executeRaw.mock.calls[1].slice(1)).toEqual([
      `note_rating:owner:${OWNER}`,
    ]);
    expect(calls[2]).toContain('INSERT INTO "NoteRatingDaily"');
    expect(calls[2]).toContain('WHERE "NoteRatingDaily"."goodCount" <');
    expect(calls[3]).toContain('INSERT INTO "NoteRatingMonthly"');
    expect(calls[3]).toContain('"goodCount"');
  });

  it('stores the reason and text of a bad rating', async () => {
    const { service, prisma } = setup();

    await service.rate(RATER, COPY, {
      value: 'BAD',
      reason: 'OTHER',
      comment: 'Phone number is wrong',
    });

    expect(prisma.noteRating.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          value: 'BAD',
          reason: 'OTHER',
          comment: 'Phone number is wrong',
        }),
      }),
    );
  });

  it.each([
    ['a bad rating without a reason', { value: 'BAD' }],
    ['OTHER without text', { value: 'BAD', reason: 'OTHER', comment: '' }],
    ['a good rating with a reason', { value: 'GOOD', reason: 'EXPIRED' }],
    ['a good rating with text', { value: 'GOOD', comment: 'nice' }],
  ])('rejects %s before touching the database', async (_label, dto) => {
    const { service, prisma } = setup();

    await expect(
      service.rate(RATER, COPY, dto as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.note.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['NOTE_RATING_OWNER', { viewer: OWNER }],
    ['NOTE_RATING_NO_GROUP', { cards: [] }],
    ['NOTE_RATING_NOT_COLLECTED', { hasCopy: false }],
    ['NOTE_RATING_NOT_IN_GROUP', { seat: false, circleMember: false }],
    ['NOTE_RATING_LOW_CREDIT', { creditScore: 89 }],
    [
      'NOTE_RATING_ACCOUNT_TOO_NEW',
      { registeredAt: new Date(NOW.getTime() - 7 * DAY + 1) },
    ],
  ] as const)(
    'rejects with %s and writes nothing',
    async (code, over: Record<string, any>) => {
      const { service, prisma } = setup(over);
      const viewer = over.viewer ?? RATER;
      // The owner opens the root itself; raters open their copy.
      const error = await rejection(
        service.rate(viewer, viewer === OWNER ? ROOT : COPY, { value: 'GOOD' }),
      );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({ errorCode: code });
      expect(prisma.noteRating.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('allows exactly 90 credit and an account exactly 7 days old', async () => {
    const { service, prisma } = setup({
      creditScore: 90,
      registeredAt: new Date(NOW.getTime() - 7 * DAY),
    });

    await service.rate(RATER, COPY, { value: 'GOOD' });

    expect(prisma.noteRating.create).toHaveBeenCalled();
  });

  it('limits a rater to one rating per Shanghai day across all notes', async () => {
    const { service, prisma } = setup({ ratedToday: true });

    const error = await rejection(service.rate(RATER, COPY, { value: 'GOOD' }));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      message: expect.any(String),
      errorCode: 'NOTE_RATING_RATER_DAILY_LIMIT',
      // Next Shanghai midnight.
      details: { nextRatableAt: new Date('2026-11-11T16:00:00.000Z') },
    });
    // The day starts at Shanghai midnight, not UTC midnight.
    expect(prisma.noteRating.findFirst).toHaveBeenCalledWith({
      where: {
        raterID: RATER,
        createdAt: { gte: new Date('2026-11-10T16:00:00.000Z') },
      },
      select: { id: true },
    });
  });

  it('keeps a 72-hour cooldown per note', async () => {
    const last = new Date(NOW.getTime() - 30 * HOUR);
    const { service, prisma } = setup({ lastOnNote: last });

    const error = await rejection(service.rate(RATER, COPY, { value: 'GOOD' }));

    expect(error.getResponse()).toMatchObject({
      errorCode: 'NOTE_RATING_COOLDOWN',
      details: { nextRatableAt: new Date(last.getTime() + 72 * HOUR) },
    });
    expect(prisma.noteRating.findFirst).toHaveBeenCalledWith({
      where: {
        raterID: RATER,
        noteID: ROOT,
        createdAt: { gt: new Date(NOW.getTime() - 72 * HOUR) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  });

  it.each([
    ['GOOD', 'NOTE_RATING_NOTE_GOOD_FULL'],
    ['BAD', 'NOTE_RATING_NOTE_BAD_FULL'],
  ] as const)(
    'rejects a %s rating when today’s 5 slots of the note are taken',
    async (value, code) => {
      const { service, prisma } = setup({ dailySlot: false });

      const error = await rejection(
        service.rate(RATER, COPY, {
          value,
          ...(value === 'BAD' ? { reason: 'EXPIRED' as const } : {}),
        }),
      );

      expect(error.getResponse()).toMatchObject({ errorCode: code });
      expect(prisma.noteRating.create).not.toHaveBeenCalled();
    },
  );

  it('holds a burst of three same-value ratings for one owner and opens a case', async () => {
    const peers = [
      {
        id: 'p1',
        noteID: ROOT,
        value: 'GOOD',
        status: 'COUNTED',
        ratedDay: new Date('2026-11-11T00:00:00.000Z'),
      },
      {
        id: 'p2',
        noteID: 'other-note',
        value: 'GOOD',
        status: 'COUNTED',
        ratedDay: new Date('2026-11-11T00:00:00.000Z'),
      },
    ];
    const { service, prisma, calls } = setup({ peers });

    const result = await service.rate(RATER, COPY, { value: 'GOOD' });

    expect(prisma.noteRating.findMany).toHaveBeenCalledWith({
      where: {
        ownerID: OWNER,
        value: 'GOOD',
        status: { in: ['COUNTED', 'HELD'] },
        createdAt: { gt: new Date(NOW.getTime() - 10 * 60 * 1000) },
        caseItems: { none: { case: { kind: 'BURST', status: 'RESOLVED' } } },
      },
      select: expect.any(Object),
    });
    expect(result.status).toBe('HELD');
    // Held ratings take no daily slot and stay out of the month row.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.noteRating.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'HELD' }),
      }),
    );
    // Both counted peers leave their day and month rows.
    // Prisma.sql renders parameters as `?`: the counter shifts add `+ ?`.
    const decrements = calls.filter((sql) => sql.includes('+ ?'));
    expect(decrements).toHaveLength(4);
    expect(prisma.noteRating.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2'] } },
      data: { status: 'HELD' },
    });
    expect(prisma.noteRatingCase.create).toHaveBeenCalledWith({
      data: { kind: 'BURST', ownerID: OWNER },
      select: { id: true },
    });
    expect(prisma.noteRatingCaseItem.createMany).toHaveBeenCalledWith({
      data: [
        { caseID: 'case-new', ratingID: 'p1' },
        { caseID: 'case-new', ratingID: 'p2' },
        { caseID: 'case-new', ratingID: 'new-rating' },
      ],
      skipDuplicates: true,
    });
  });

  it('adds a later burst rating to the open case of its held peers', async () => {
    const day = new Date('2026-11-11T00:00:00.000Z');
    const peers = ['p1', 'p2', 'p3'].map((id) => ({
      id,
      noteID: ROOT,
      value: 'BAD',
      status: 'HELD',
      ratedDay: day,
    }));
    const { service, prisma } = setup({ peers, openBurstCase: 'case-open' });

    await service.rate(RATER, COPY, { value: 'BAD', reason: 'EXPIRED' });

    expect(prisma.noteRatingCase.create).not.toHaveBeenCalled();
    // Already held: no status change, no counter change.
    expect(prisma.noteRating.updateMany).not.toHaveBeenCalled();
    expect(prisma.noteRatingCaseItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { caseID: 'case-open', ratingID: 'new-rating' },
      ]),
      skipDuplicates: true,
    });
  });

  it('does not treat two ratings in the window as a burst', async () => {
    const { service, prisma } = setup({
      peers: [
        {
          id: 'p1',
          noteID: ROOT,
          value: 'GOOD',
          status: 'COUNTED',
          ratedDay: new Date('2026-11-11T00:00:00.000Z'),
        },
      ],
    });

    const result = await service.rate(RATER, COPY, { value: 'GOOD' });

    expect(result.status).toBe('COUNTED');
    expect(prisma.noteRatingCase.create).not.toHaveBeenCalled();
  });

  it('404s for a note the viewer cannot read', async () => {
    const { service } = setup();

    await expect(
      service.rate(RATER, 'unknown', { value: 'GOOD' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NoteRatingService.getSummary', () => {
  it("returns this month's counters, eligibility and today's quota state", async () => {
    const { service } = setup({
      monthly: { goodCount: 12, badCount: 2 },
      daily: { goodCount: 5, badCount: 1 },
    });

    await expect(service.getSummary(RATER, COPY)).resolves.toEqual({
      noteId: ROOT,
      month: '2026-11',
      goodCount: 12,
      badCount: 2,
      canRate: true,
      reason: null,
      nextRatableAt: null,
      goodFull: true,
      badFull: false,
    });
  });

  it('shows 0 when the month has no row yet (the monthly reset)', async () => {
    const { service, prisma } = setup();

    const summary = await service.getSummary(RATER, COPY);

    expect(summary).toMatchObject({ goodCount: 0, badCount: 0 });
    expect(prisma.noteRatingMonthly.findMany).toHaveBeenCalledWith({
      where: { noteID: { in: [ROOT] }, month: '2026-11' },
      select: { noteID: true, goodCount: true, badCount: true },
    });
  });

  it('explains the block to the owner without rating buttons', async () => {
    const { service } = setup();

    await expect(service.getSummary(OWNER, ROOT)).resolves.toMatchObject({
      canRate: false,
      reason: 'NOTE_RATING_OWNER',
    });
  });

  it('reports the later of the daily reset and the cooldown end', async () => {
    const last = new Date(NOW.getTime() - 2 * HOUR);
    const { service } = setup({ ratedToday: true, lastOnNote: last });

    await expect(service.getSummary(RATER, COPY)).resolves.toMatchObject({
      reason: 'NOTE_RATING_RATER_DAILY_LIMIT',
      nextRatableAt: new Date(last.getTime() + 72 * HOUR),
    });
  });
});

describe('group membership', () => {
  it('checks circle cards (including legacy OpenIM ids) and standalone groups', async () => {
    const { service, prisma } = setup({
      cards: [
        { id: 'circle-uuid', name: 'Circle' },
        { id: 'openim-group', circleId: 'circle-legacy', name: 'Legacy' },
        { id: 'conv-9', conversationID: 'conv-9', name: 'Standalone' },
      ],
      circleMember: false,
      seat: true,
    });

    await service.getSummary(RATER, COPY);

    expect(prisma.circle.findFirst).toHaveBeenCalledWith({
      where: {
        deleted: false,
        AND: [
          {
            OR: [
              { id: { in: ['circle-uuid', 'openim-group', 'circle-legacy'] } },
              {
                groupID: {
                  in: ['circle-uuid', 'openim-group', 'circle-legacy'],
                },
              },
            ],
          },
          {
            OR: [
              { ownerID: RATER },
              { members: { some: { userID: RATER, status: 'ACTIVE' } } },
            ],
          },
        ],
      },
      select: { id: true },
    });
    expect(prisma.chatMember.findFirst).toHaveBeenCalledWith({
      where: {
        userID: RATER,
        leftAt: null,
        conversationID: { in: ['circle-uuid', 'openim-group', 'conv-9'] },
        conversation: { type: 'GROUP', circleID: null },
      },
      select: { id: true },
    });
  });

  it('accepts an active circle member without looking at chat seats', async () => {
    const { service, prisma } = setup({
      cards: [{ id: 'circle-uuid', name: 'Circle' }],
      circleMember: true,
    });

    await expect(service.getSummary(RATER, COPY)).resolves.toMatchObject({
      canRate: true,
    });
    expect(prisma.chatMember.findFirst).not.toHaveBeenCalled();
  });

  it('reads group cards defensively from stored sections', () => {
    expect(groupCardsOf(null)).toEqual([]);
    expect(groupCardsOf({ groups: { items: 'x' } })).toEqual([]);
    expect(
      groupCardsOf({
        groups: {
          items: [null, { name: 'no id' }, { id: '', name: 'x' }, { id: 'g' }],
        },
      }),
    ).toEqual([{ id: 'g', circleId: undefined, conversationID: undefined }]);
  });
});
