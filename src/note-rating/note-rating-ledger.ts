import {
  Prisma,
  type NoteRatingStatus,
  type NoteRatingValue,
} from 'src/generated/prisma';
import { NOTE_RATING_NOTE_DAILY_CAP } from './note-rating.constants';
import { dayKeyOf, monthOf } from './note-rating-calendar';

/**
 * Counter bookkeeping shared by rating, burst holds and admin decisions.
 *
 * Invariant: NoteRatingDaily / NoteRatingMonthly hold exactly the number of
 * COUNTED ratings per (note, day|month, value). Every status change goes
 * through `transitionRatings`, and every writer holds the owner's advisory
 * lock (`lockOwner` below), so these upserts never race each other.
 */
type Tx = Prisma.TransactionClient;

export type LedgerRating = {
  id: string;
  noteID: string;
  value: NoteRatingValue;
  status: NoteRatingStatus;
  ratedDay: Date;
};

const counterColumn = (value: NoteRatingValue) =>
  value === 'GOOD' ? Prisma.raw('"goodCount"') : Prisma.raw('"badCount"');

/**
 * Takes one of today's per-note slots for a new counted rating. Returns false
 * when the note already has NOTE_RATING_NOTE_DAILY_CAP counted ratings of this
 * value today: the conditional DO UPDATE leaves the row alone and returns
 * nothing.
 */
export async function claimDailySlot(
  tx: Tx,
  noteID: string,
  dayKey: string,
  value: NoteRatingValue,
): Promise<boolean> {
  const column = counterColumn(value);
  const rows = await tx.$queryRaw<Array<{ noteID: string }>>`
    INSERT INTO "NoteRatingDaily" ("noteID", "day", ${column})
    VALUES (${noteID}, ${dayKey}::date, 1)
    ON CONFLICT ("noteID", "day") DO UPDATE
      SET ${column} = "NoteRatingDaily".${column} + 1
      WHERE "NoteRatingDaily".${column} < ${NOTE_RATING_NOTE_DAILY_CAP}
    RETURNING "noteID"`;
  return rows.length > 0;
}

export async function adjustMonthly(
  tx: Tx,
  noteID: string,
  month: string,
  value: NoteRatingValue,
  delta: 1 | -1,
): Promise<void> {
  const column = counterColumn(value);
  await tx.$executeRaw`
    INSERT INTO "NoteRatingMonthly" ("noteID", "month", ${column})
    VALUES (${noteID}, ${month}, ${Math.max(delta, 0)})
    ON CONFLICT ("noteID", "month") DO UPDATE
      SET ${column} = "NoteRatingMonthly".${column} + ${delta}`;
}

async function adjustDaily(
  tx: Tx,
  noteID: string,
  dayKey: string,
  value: NoteRatingValue,
  delta: 1 | -1,
): Promise<void> {
  const column = counterColumn(value);
  await tx.$executeRaw`
    INSERT INTO "NoteRatingDaily" ("noteID", "day", ${column})
    VALUES (${noteID}, ${dayKey}::date, ${Math.max(delta, 0)})
    ON CONFLICT ("noteID", "day") DO UPDATE
      SET ${column} = "NoteRatingDaily".${column} + ${delta}`;
}

/**
 * Moves ratings to `to`, adding or removing their contribution in the day and
 * month rows they were made in. Ratings already in `to` are left alone.
 * Returns the ratings that actually changed.
 */
export async function transitionRatings(
  tx: Tx,
  ratings: readonly LedgerRating[],
  to: NoteRatingStatus,
): Promise<LedgerRating[]> {
  const changed = ratings.filter((rating) => rating.status !== to);
  if (changed.length === 0) return [];
  for (const rating of changed) {
    const wasCounted = rating.status === 'COUNTED';
    if (wasCounted === (to === 'COUNTED')) continue;
    const delta = wasCounted ? -1 : 1;
    await adjustDaily(
      tx,
      rating.noteID,
      dayKeyOf(rating.ratedDay),
      rating.value,
      delta,
    );
    await adjustMonthly(
      tx,
      rating.noteID,
      monthOf(rating.ratedDay),
      rating.value,
      delta,
    );
  }
  await tx.noteRating.updateMany({
    where: { id: { in: changed.map((rating) => rating.id) } },
    data: { status: to },
  });
  return changed;
}

/** Serializes every counter writer for one owner, and a rater's own limits. */
export async function lockRater(tx: Tx, raterID: string): Promise<void> {
  const key = 'note_rating:rater:' + raterID;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export async function lockOwner(tx: Tx, ownerID: string): Promise<void> {
  const key = 'note_rating:owner:' + ownerID;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
