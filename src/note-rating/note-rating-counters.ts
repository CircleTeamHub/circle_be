import type { Prisma } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';
import { ratingCalendar } from './note-rating-calendar';

export type NoteRatingCounters = { goodCount: number; badCount: number };

export const ZERO_RATING_COUNTERS: NoteRatingCounters = {
  goodCount: 0,
  badCount: 0,
};

/**
 * This month's displayed counters for the given source (root) notes. Notes with
 * no row this month are simply absent: callers show 0, which is how the monthly
 * reset works without a scheduled job.
 */
export async function loadMonthlyCounters(
  client: PrismaService | Prisma.TransactionClient,
  noteIds: readonly string[],
  now = new Date(),
): Promise<Map<string, NoteRatingCounters>> {
  const ids = [...new Set(noteIds)];
  if (ids.length === 0) return new Map();
  const rows = await client.noteRatingMonthly.findMany({
    where: { noteID: { in: ids }, month: ratingCalendar(now).month },
    select: { noteID: true, goodCount: true, badCount: true },
  });
  return new Map(
    rows.map((row) => [
      row.noteID,
      { goodCount: row.goodCount, badCount: row.badCount },
    ]),
  );
}
