import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { NoteRatingService } from './note-rating.service';

const OWNER = 'owner-1';
const ROOT = 'root-note';
const NOW = new Date('2026-11-20T04:00:00.000Z');

const badRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  reason: 'EXPIRED',
  comment: null,
  status: 'COUNTED',
  createdAt: new Date('2026-11-19T00:00:00.000Z'),
  caseItems: [],
  ...over,
});

function setup(
  over: {
    rows?: Array<Record<string, unknown>>;
    appealsUsed?: number;
    rating?: Record<string, unknown> | null;
  } = {},
) {
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $executeRaw: jest.fn(async () => 1),
    note: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === ROOT
          ? { id: ROOT, rootSourceNoteID: null, ownerID: OWNER, sections: {} }
          : null,
      ),
    },
    noteRating: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          // Without ownerID it is the list cursor lookup.
          if (!where.ownerID) {
            return {
              id: 'cursor',
              createdAt: new Date('2026-11-18T00:00:00.000Z'),
            };
          }
          return over.rating === undefined
            ? { id: 'r1', noteID: ROOT, status: 'COUNTED', caseItems: [] }
            : over.rating;
        },
      ),
      findMany: jest.fn(async () => over.rows ?? [badRow()]),
      findUniqueOrThrow: jest.fn(async () =>
        badRow({
          caseItems: [
            {
              case: {
                status: 'PENDING',
                resolution: null,
                ownerReason: 'The shop is open again',
                createdAt: NOW,
                resolvedAt: null,
              },
            },
          ],
        }),
      ),
      updateMany: jest.fn(),
    },
    noteRatingCase: {
      count: jest.fn(async () => over.appealsUsed ?? 0),
      create: jest.fn(async () => ({ id: 'appeal-1' })),
    },
  };
  return { service: new NoteRatingService(prisma as never), prisma };
}

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW.getTime(),
    doNotFake: ['nextTick', 'setImmediate'],
  });
});
afterEach(() => jest.useRealTimers());

describe('NoteRatingService.listBadRatings', () => {
  it('shows the owner reason, text, time and appeal state but never the rater', async () => {
    const { service, prisma } = setup({
      rows: [
        badRow({ id: 'a', comment: 'closed', reason: 'OTHER' }),
        badRow({
          id: 'b',
          caseItems: [
            {
              case: {
                status: 'RESOLVED',
                resolution: 'REVOKE',
                ownerReason: 'wrong',
                createdAt: NOW,
                resolvedAt: NOW,
              },
            },
          ],
          status: 'VOID',
        }),
        badRow({ id: 'c', status: 'HELD' }),
      ],
      appealsUsed: 1,
    });

    const page = await service.listBadRatings(OWNER, ROOT, {});

    const query = prisma.noteRating.findMany.mock.calls[0][0] as {
      where: unknown;
      select: Record<string, unknown>;
    };
    expect(query.where).toEqual({ noteID: ROOT, value: 'BAD' });
    expect(query.select).not.toHaveProperty('raterID');
    expect(query.select).not.toHaveProperty('rater');
    expect(page).toEqual({
      items: [
        expect.objectContaining({
          id: 'a',
          reason: 'OTHER',
          comment: 'closed',
          appeal: null,
          canAppeal: true,
        }),
        expect.objectContaining({
          id: 'b',
          status: 'VOID',
          appeal: {
            status: 'REVOKED',
            reason: 'wrong',
            createdAt: NOW,
            resolvedAt: NOW,
          },
          canAppeal: false,
        }),
        // Held by burst review: not counted, so nothing to appeal.
        expect.objectContaining({ id: 'c', canAppeal: false }),
      ],
      nextCursor: null,
      appealsRemaining: 4,
    });
    // Monthly quota counts appeals filed since Shanghai month start.
    expect(prisma.noteRatingCase.count).toHaveBeenCalledWith({
      where: {
        ownerID: OWNER,
        kind: 'APPEAL',
        createdAt: { gte: new Date('2026-10-31T16:00:00.000Z') },
      },
    });
  });

  it('pages by (createdAt, id) and returns the next cursor', async () => {
    const { service, prisma } = setup({
      rows: [badRow({ id: 'x1' }), badRow({ id: 'x2' }), badRow({ id: 'x3' })],
    });

    const page = await service.listBadRatings(OWNER, ROOT, {
      cursor: '00000000-0000-4000-8000-000000000000',
      limit: 2,
    });

    expect(page.items.map((item) => item.id)).toEqual(['x1', 'x2']);
    expect(page.nextCursor).toBe('x2');
    expect(prisma.noteRating.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          noteID: ROOT,
          value: 'BAD',
          OR: [
            { createdAt: { lt: new Date('2026-11-18T00:00:00.000Z') } },
            {
              createdAt: new Date('2026-11-18T00:00:00.000Z'),
              id: { lt: 'cursor' },
            },
          ],
        },
        take: 3,
      }),
    );
  });

  it('is only for the owner of the source note', async () => {
    const { service } = setup();

    await expect(
      service.listBadRatings('someone-else', ROOT, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('NoteRatingService.appeal', () => {
  it('opens an appeal under the owner lock and leaves the rating counted', async () => {
    const { service, prisma } = setup({ appealsUsed: 4 });

    const item = await service.appeal(OWNER, 'r1', {
      reason: 'The shop is open again',
    });

    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([
      `note_rating:owner:${OWNER}`,
    ]);
    expect(prisma.noteRatingCase.create).toHaveBeenCalledWith({
      data: {
        kind: 'APPEAL',
        ownerID: OWNER,
        ownerReason: 'The shop is open again',
        items: { create: { ratingID: 'r1' } },
      },
      select: { id: true },
    });
    expect(prisma.noteRating.updateMany).not.toHaveBeenCalled();
    expect(item).toMatchObject({
      status: 'COUNTED',
      appeal: { status: 'PENDING', reason: 'The shop is open again' },
      canAppeal: false,
    });
  });

  it.each([
    ['NOTE_RATING_NOT_FOUND', NotFoundException, { rating: null }],
    [
      'NOTE_RATING_ALREADY_APPEALED',
      ConflictException,
      {
        rating: {
          id: 'r1',
          noteID: ROOT,
          status: 'COUNTED',
          caseItems: [{ case: {} }],
        },
      },
    ],
    [
      'NOTE_RATING_NOT_APPEALABLE',
      ConflictException,
      { rating: { id: 'r1', noteID: ROOT, status: 'HELD', caseItems: [] } },
    ],
    ['NOTE_RATING_APPEAL_QUOTA', ConflictException, { appealsUsed: 5 }],
  ] as const)('rejects with %s', async (code, type, over) => {
    const { service, prisma } = setup(over as never);

    const error = await service
      .appeal(OWNER, 'r1', { reason: 'please' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(type);
    expect((error as ConflictException).getResponse()).toMatchObject({
      errorCode: code,
    });
    expect(prisma.noteRatingCase.create).not.toHaveBeenCalled();
  });

  it('only finds bad ratings received by the caller', async () => {
    const { service, prisma } = setup();

    await service.appeal(OWNER, 'r1', { reason: 'please' });

    expect(prisma.noteRating.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1', ownerID: OWNER, value: 'BAD' },
      }),
    );
  });
});
