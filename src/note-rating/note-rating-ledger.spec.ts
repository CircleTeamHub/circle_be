import { Prisma } from 'src/generated/prisma';
import { ratingCalendar } from './note-rating-calendar';
import { transitionRatings, type LedgerRating } from './note-rating-ledger';

function rendered(call: unknown[]): Prisma.Sql {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
}

describe('ratingCalendar (Asia/Shanghai, UTC+8)', () => {
  it('rolls the day over at 16:00 UTC', () => {
    expect(ratingCalendar(new Date('2026-11-11T15:59:59.999Z'))).toMatchObject({
      dayKey: '2026-11-11',
      dayStart: new Date('2026-11-10T16:00:00.000Z'),
      nextDayStart: new Date('2026-11-11T16:00:00.000Z'),
    });
    expect(ratingCalendar(new Date('2026-11-11T16:00:00.000Z'))).toMatchObject({
      dayKey: '2026-11-12',
      day: new Date('2026-11-12T00:00:00.000Z'),
    });
  });

  it('starts a new counter month on the 1st in Shanghai', () => {
    expect(ratingCalendar(new Date('2026-11-30T15:59:00.000Z'))).toMatchObject({
      month: '2026-11',
      monthStart: new Date('2026-10-31T16:00:00.000Z'),
    });
    expect(ratingCalendar(new Date('2026-11-30T16:00:00.000Z'))).toMatchObject({
      month: '2026-12',
      monthStart: new Date('2026-11-30T16:00:00.000Z'),
    });
    expect(ratingCalendar(new Date('2026-12-31T16:30:00.000Z')).month).toBe(
      '2027-01',
    );
  });
});

describe('transitionRatings', () => {
  const rating = (over: Partial<LedgerRating>): LedgerRating => ({
    id: 'r',
    noteID: 'note-1',
    value: 'GOOD',
    status: 'COUNTED',
    ratedDay: new Date('2026-10-31T00:00:00.000Z'),
    ...over,
  });

  function tx() {
    return {
      $executeRaw: jest.fn(async () => 1),
      noteRating: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
  }

  it('takes a counted rating out of the day and month it was made in', async () => {
    const client = tx();

    await transitionRatings(client as never, [rating({ id: 'a' })], 'HELD');

    const [daily, monthly] = client.$executeRaw.mock.calls.map((call) =>
      rendered(call as unknown[]),
    );
    expect(daily.sql).toContain('INSERT INTO "NoteRatingDaily"');
    expect(daily.sql).toContain(
      '"goodCount" = "NoteRatingDaily"."goodCount" + ?',
    );
    expect(daily.values).toEqual(['note-1', '2026-10-31', 0, -1]);
    expect(monthly.sql).toContain('INSERT INTO "NoteRatingMonthly"');
    // An October rating released or voided in November moves October's row.
    expect(monthly.values).toEqual(['note-1', '2026-10', 0, -1]);
    expect(client.noteRating.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] } },
      data: { status: 'HELD' },
    });
  });

  it('adds a released bad rating back to the bad counters', async () => {
    const client = tx();

    await transitionRatings(
      client as never,
      [rating({ id: 'b', value: 'BAD', status: 'HELD' })],
      'COUNTED',
    );

    const daily = rendered(client.$executeRaw.mock.calls[0] as unknown[]);
    expect(daily.sql).toContain(
      '"badCount" = "NoteRatingDaily"."badCount" + ?',
    );
    expect(daily.values).toEqual(['note-1', '2026-10-31', 1, 1]);
  });

  it('moves held ratings to VOID without touching counters, and skips ratings already there', async () => {
    const client = tx();

    const changed = await transitionRatings(
      client as never,
      [
        rating({ id: 'h', status: 'HELD' }),
        rating({ id: 'v', status: 'VOID' }),
      ],
      'VOID',
    );

    expect(changed.map((item) => item.id)).toEqual(['h']);
    expect(client.$executeRaw).not.toHaveBeenCalled();
    expect(client.noteRating.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['h'] } },
      data: { status: 'VOID' },
    });
  });

  it('does nothing when every rating is already in the target status', async () => {
    const client = tx();

    await expect(
      transitionRatings(client as never, [rating({})], 'COUNTED'),
    ).resolves.toEqual([]);
    expect(client.noteRating.updateMany).not.toHaveBeenCalled();
  });
});
