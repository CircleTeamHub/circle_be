import { CreditService } from 'src/credit/credit.service';
import { NoteRatingAdminService } from 'src/note-rating/note-rating-admin.service';
import { NoteRatingService } from 'src/note-rating/note-rating.service';
import { ratingCalendar } from 'src/note-rating/note-rating-calendar';
import { loadMonthlyCounters } from 'src/note-rating/note-rating-counters';
import { describePostgres } from './pg-test-db';
import { type LiveSchema, openLiveSchema, seedUsers } from './live-prisma';

/**
 * Note ratings on a real PostgreSQL + real PrismaClient: the raw counter SQL
 * (conditional daily increment, ON CONFLICT upserts, ::date parameters) and the
 * advisory locks only prove themselves against a database.
 *
 * - One rater, two notes, submitted at once: the rater lock lets exactly one in.
 * - Three raters of one owner at once: the owner lock makes the last one see the
 *   other two, so all three end up HELD in one BURST case and nothing is counted.
 * - Admin decisions move the day/month rows and the raters' credit.
 */
jest.setTimeout(60_000);

const OWNER = 'owner';
const RATERS = ['r1', 'r2', 'r3', 'r4', 'r5'];
const ADMIN = 'admin';
const ROOTS = ['root-a', 'root-b'];

describePostgres('note ratings on PostgreSQL', () => {
  let live: LiveSchema;
  let ratings: NoteRatingService;
  let admin: NoteRatingAdminService;

  beforeAll(async () => {
    live = await openLiveSchema('note_rating');
    const realtime = {
      safeBroadcastAll: jest.fn(async () => undefined),
      invalidateUserProfileSummaryCache: jest.fn(async () => true),
      broadcastUserProfileSummary: jest.fn(async () => undefined),
      broadcastSystemNotificationCreated: jest.fn(),
      broadcastNotificationCreated: jest.fn(),
      broadcastSystemNotificationUnread: jest.fn(),
    };
    ratings = new NoteRatingService(live.prisma as never);
    admin = new NoteRatingAdminService(
      live.prisma as never,
      new CreditService(live.prisma as never, realtime as never),
      { createSystemNotification: jest.fn(async () => null) } as never,
      realtime as never,
    );

    await seedUsers(live.db, [OWNER, ADMIN, ...RATERS]);
    await live.db.query(
      `UPDATE "User" SET "createdAt" = now() - interval '30 days'`,
    );
    await live.db.query(
      `INSERT INTO "ChatConversation" (id, type, "updatedAt") VALUES ('group-1', 'GROUP', now())`,
    );
    await live.db.query(
      `INSERT INTO "ChatMember" (id, "conversationID", "userID")
       SELECT 'seat-' || id, 'group-1', id FROM unnest($1::text[]) AS id`,
      [RATERS],
    );
    const sections = JSON.stringify({
      groups: {
        items: [{ id: 'group-1', name: 'Group', conversationID: 'group-1' }],
      },
    });
    for (const root of ROOTS) {
      await live.db.query(
        `INSERT INTO "Note" (id, "ownerID", title, sections, "updatedAt")
         VALUES ($1, $2, 'Shop', $3::jsonb, now())`,
        [root, OWNER, sections],
      );
      // Every rater holds a collected copy of every root.
      await live.db.query(
        `INSERT INTO "Note" (id, "ownerID", title, "collectedFromNoteID", "rootSourceNoteID", "updatedAt")
         SELECT 'copy-' || $1 || '-' || id, id, 'Shop', $1, $1, now()
         FROM unnest($2::text[]) AS id`,
        [root, RATERS],
      );
    }
  });

  afterAll(async () => {
    await live?.close();
  });

  beforeEach(async () => {
    await live.db.query(`
      TRUNCATE "NoteRatingCaseItem", "NoteRatingCase", "NoteRating",
               "NoteRatingDaily", "NoteRatingMonthly", "CreditEvent";
      UPDATE "User" SET "creditScore" = 100;
    `);
  });

  const today = () => ratingCalendar(new Date());

  async function counters(noteID: string) {
    const { rows: daily } = await live.db.query<{
      goodCount: number;
      badCount: number;
    }>(
      `SELECT "goodCount", "badCount" FROM "NoteRatingDaily" WHERE "noteID" = $1 AND day = $2::date`,
      [noteID, today().dayKey],
    );
    const { rows: monthly } = await live.db.query<{
      goodCount: number;
      badCount: number;
    }>(
      `SELECT "goodCount", "badCount" FROM "NoteRatingMonthly" WHERE "noteID" = $1 AND month = $2`,
      [noteID, today().month],
    );
    return {
      daily: daily[0] ?? { goodCount: 0, badCount: 0 },
      monthly: monthly[0] ?? { goodCount: 0, badCount: 0 },
    };
  }

  async function statuses(): Promise<string[]> {
    const { rows } = await live.db.query<{ status: string }>(
      `SELECT status FROM "NoteRating" ORDER BY "createdAt"`,
    );
    return rows.map((row) => row.status);
  }

  it('counts a rating on the root and then holds the rater to one a day', async () => {
    const result = await ratings.rate('r1', 'copy-root-a-r1', {
      value: 'GOOD',
    });

    expect(result).toMatchObject({
      noteId: 'root-a',
      goodCount: 1,
      badCount: 0,
      status: 'COUNTED',
    });
    expect(await counters('root-a')).toEqual({
      daily: { goodCount: 1, badCount: 0 },
      monthly: { goodCount: 1, badCount: 0 },
    });
    await expect(
      ratings.rate('r1', 'copy-root-b-r1', { value: 'GOOD' }),
    ).rejects.toMatchObject({
      response: { errorCode: 'NOTE_RATING_RATER_DAILY_LIMIT' },
    });
    await expect(ratings.getSummary('r1', 'root-a')).resolves.toMatchObject({
      goodCount: 1,
      canRate: false,
      reason: 'NOTE_RATING_RATER_DAILY_LIMIT',
    });
  });

  it('lets exactly one of two simultaneous ratings by one rater through', async () => {
    const results = await Promise.allSettled([
      ratings.rate('r2', 'copy-root-a-r2', { value: 'GOOD' }),
      ratings.rate('r2', 'copy-root-b-r2', { value: 'GOOD' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { response: { errorCode: 'NOTE_RATING_RATER_DAILY_LIMIT' } },
    });
    expect(await statuses()).toEqual(['COUNTED']);
  });

  it('holds three simultaneous same-value ratings for one owner as one burst', async () => {
    await Promise.all(
      ['r1', 'r2', 'r3'].map((rater, index) =>
        ratings.rate(rater, `copy-${ROOTS[index % 2]}-${rater}`, {
          value: 'GOOD',
        }),
      ),
    );

    expect(await statuses()).toEqual(['HELD', 'HELD', 'HELD']);
    expect(await counters('root-a')).toEqual({
      daily: { goodCount: 0, badCount: 0 },
      monthly: { goodCount: 0, badCount: 0 },
    });
    const { rows: cases } = await live.db.query<{
      kind: string;
      items: number;
    }>(
      `SELECT c.kind, count(i.*)::int AS items FROM "NoteRatingCase" c
       JOIN "NoteRatingCaseItem" i ON i."caseID" = c.id GROUP BY c.id, c.kind`,
    );
    expect(cases).toEqual([{ kind: 'BURST', items: 3 }]);

    // Release: back into the counters of the day and month they were made in.
    const [pending] = (await admin.listCases({})).items;
    await admin.resolveCase(ADMIN, pending.id, { action: 'RELEASE' });
    expect(await statuses()).toEqual(['COUNTED', 'COUNTED', 'COUNTED']);
    const a = await counters('root-a');
    const b = await counters('root-b');
    expect(a.monthly.goodCount + b.monthly.goodCount).toBe(3);
    expect(a.daily.goodCount + b.daily.goodCount).toBe(3);
  });

  it('voids a burst, deducts 15 credit per rater and so removes their rating rights', async () => {
    for (const rater of ['r1', 'r2', 'r3']) {
      await ratings.rate(rater, `copy-root-a-${rater}`, {
        value: 'BAD',
        reason: 'INACCURATE',
      });
    }
    const [pending] = (await admin.listCases({ kind: 'BURST' })).items;

    const resolved = await admin.resolveCase(ADMIN, pending.id, {
      action: 'VOID',
    });

    expect(resolved).toMatchObject({ status: 'RESOLVED', resolution: 'VOID' });
    expect(await statuses()).toEqual(['VOID', 'VOID', 'VOID']);
    const { rows: users } = await live.db.query<{
      id: string;
      creditScore: number;
    }>(`SELECT id, "creditScore" FROM "User" WHERE id = ANY($1) ORDER BY id`, [
      ['r1', 'r2', 'r3'],
    ]);
    expect(users.map((user) => user.creditScore)).toEqual([85, 85, 85]);
    await expect(ratings.getSummary('r1', 'root-b')).resolves.toMatchObject({
      reason: 'NOTE_RATING_LOW_CREDIT',
    });
    // A second admin cannot apply the decision (or the deduction) again.
    await expect(
      admin.resolveCase(ADMIN, pending.id, { action: 'VOID' }),
    ).rejects.toMatchObject({
      response: { errorCode: 'NOTE_RATING_CASE_RESOLVED' },
    });
  });

  it("caps a note's counted ratings per day and value with the conditional increment", async () => {
    await live.db.query(
      `INSERT INTO "NoteRatingDaily" ("noteID", day, "goodCount") VALUES ('root-a', $1::date, 5)`,
      [today().dayKey],
    );

    await expect(
      ratings.rate('r4', 'copy-root-a-r4', { value: 'GOOD' }),
    ).rejects.toMatchObject({
      response: { errorCode: 'NOTE_RATING_NOTE_GOOD_FULL' },
    });
    await expect(ratings.getSummary('r4', 'root-a')).resolves.toMatchObject({
      canRate: true,
      goodFull: true,
      badFull: false,
    });
    // The rejected attempt rolled back, so the rater still has today's rating.
    await expect(
      ratings.rate('r4', 'copy-root-a-r4', { value: 'BAD', reason: 'EXPIRED' }),
    ).resolves.toMatchObject({ status: 'COUNTED', badCount: 1 });
    expect((await counters('root-a')).daily).toEqual({
      goodCount: 5,
      badCount: 1,
    });
  });

  it('keeps an appealed bad rating counted until an admin revokes it', async () => {
    const { ratingId } = await ratings.rate('r5', 'copy-root-a-r5', {
      value: 'BAD',
      reason: 'OTHER',
      comment: 'Closed for good',
    });

    const appealed = await ratings.appeal(OWNER, ratingId, {
      reason: 'We reopened last week',
    });
    expect(appealed).toMatchObject({
      status: 'COUNTED',
      appeal: { status: 'PENDING' },
      canAppeal: false,
    });
    expect((await counters('root-a')).monthly.badCount).toBe(1);
    await expect(
      ratings.appeal(OWNER, ratingId, { reason: 'again' }),
    ).rejects.toMatchObject({
      response: { errorCode: 'NOTE_RATING_ALREADY_APPEALED' },
    });

    const list = await ratings.listBadRatings(OWNER, 'root-a', {});
    expect(list.appealsRemaining).toBe(4);
    expect(JSON.stringify(list)).not.toContain('r5');

    const [pending] = (await admin.listCases({ kind: 'APPEAL' })).items;
    expect(pending.ownerReason).toBe('We reopened last week');
    expect(pending.ratings[0].rater.id).toBe('r5');
    await admin.resolveCase(ADMIN, pending.id, { action: 'REVOKE' });

    expect(await statuses()).toEqual(['VOID']);
    expect(await counters('root-a')).toEqual({
      daily: { goodCount: 0, badCount: 0 },
      monthly: { goodCount: 0, badCount: 0 },
    });
    const { rows } = await live.db.query<{ creditScore: number }>(
      `SELECT "creditScore" FROM "User" WHERE id = 'r5'`,
    );
    expect(rows[0].creditScore).toBe(85);
    await expect(
      ratings.listBadRatings(OWNER, 'root-a', {}),
    ).resolves.toMatchObject({
      items: [{ status: 'VOID', appeal: { status: 'REVOKED' } }],
    });
  });

  it('shows the root counters on note reads of a copy', async () => {
    await ratings.rate('r1', 'copy-root-a-r1', { value: 'GOOD' });

    const map = await loadMonthlyCounters(live.prisma as never, [
      'root-a',
      'root-b',
    ]);
    expect(map.get('root-a')).toEqual({ goodCount: 1, badCount: 0 });
    expect(map.has('root-b')).toBe(false);
  });
});
