# Note ratings (好评 / 差评)

Product spec: `Circle_frontend/docs/superpowers/specs/2026-11-11-note-rating-design.md`
(decided 2026-11-11). This page records how the backend implements it. Code lives
in `src/note-rating/`; limits are in `note-rating.constants.ts`.

## Where a rating lives

A rating is an event row in `NoteRating`, always recorded on the **root of the
collect chain** (`Note.rootSourceNoteID ?? Note.id`). A collected copy, or a copy of
a copy, shows its root's counters. `NoteRating.noteID` has no foreign key: notes go
to the recycle bin (`status = DELETED`) and are hard-deleted 30 days later
(`note-purge.ts`); ratings, cases and credit events stay for audit. `ownerID` is the
root's owner, denormalised for burst detection and a later collusion check.

## Who can rate

Checked server-side on every attempt, in this order (the first failure is the
`NOTE_RATING_*` code returned, and the `reason` in the summary):

| Code                                       | Rule                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `NOTE_RATING_OWNER`                        | the viewer owns the root                                         |
| `NOTE_RATING_NO_GROUP`                     | the root has no group cards (`sections.groups.items`)            |
| `NOTE_RATING_NOT_COLLECTED`                | the viewer holds no non-deleted copy (`rootSourceNoteID = root`) |
| `NOTE_RATING_NOT_IN_GROUP`                 | the viewer is in none of the root's groups                       |
| `NOTE_RATING_LOW_CREDIT`                   | `creditScore < 90`                                               |
| `NOTE_RATING_ACCOUNT_TOO_NEW`              | registered less than 7 days ago                                  |
| `NOTE_RATING_RATER_DAILY_LIMIT`            | the viewer already rated any note today (Asia/Shanghai)          |
| `NOTE_RATING_COOLDOWN`                     | the viewer rated this note within 72 hours                       |
| `NOTE_RATING_NOTE_GOOD_FULL` / `_BAD_FULL` | the note already has 5 counted ratings of that value today       |

Group card membership (resolves the spec's first "to confirm" item):

- A card with `conversationID` is a standalone group chat: the viewer needs a seat
  (`ChatMember.leftAt IS NULL`) in that GROUP conversation without a circle.
- Any other card is a circle card. Its `id` is the circle id or, on legacy cards,
  the OpenIM group id (`Circle.groupID`) with the circle id in `circleId`. The
  viewer must be the owner or an `ACTIVE` `CircleMember` of a non-deleted circle.

These are the same rules `NoteService.canonicalizeNoteCards` applies when the
owner attaches a card.

## Writes and locking

A rating runs in one transaction holding two advisory locks: the rater's (daily
limit, cooldown) and the root owner's (burst detection and counters). Every writer
of an owner's counters — new ratings, appeals, admin decisions — takes the owner
lock, so the counter upserts never race.

- `NoteRatingDaily (noteID, day)` holds the counted ratings per day and value. A
  new counted rating claims a slot with
  `INSERT … ON CONFLICT DO UPDATE SET goodCount = goodCount + 1 WHERE goodCount < 5`;
  no returned row means the day is full.
- `NoteRatingMonthly (noteID, month)` holds the displayed counters. Readers take
  the current Shanghai month's row and show 0 without one, so the monthly reset
  needs no job. Status changes adjust the rows of the day and month the rating
  was made in (`transitionRatings`).
- Invariant: both tables equal the number of `COUNTED` ratings per bucket.

## Burst detection

On insert, if the root owner has received ≥ 3 ratings of the same value within 10
minutes (counting the new one, statuses `COUNTED` or `HELD`), all of them become
`HELD` and a `BURST` case opens (or the open case of those peers is extended). Every
rating of a note is also a rating of its owner, so the owner window covers the
spec's "same note or same owner". Held ratings release their daily slots and leave
the month counters; they still used the rater's daily quota.

## Appeals

`POST /note/ratings/:ratingId/appeal`: once per bad rating, 5 per owner per
Shanghai month, only while the rating is `COUNTED`. The rating stays counted
while the appeal is pending.

## Admin decisions (`/admin/note-ratings`, `MODERATION_MANAGE`)

| Case   | Action    | Effect                                                            |
| ------ | --------- | ----------------------------------------------------------------- |
| BURST  | `RELEASE` | held → `COUNTED`, counters restored                               |
| BURST  | `VOID`    | → `VOID`, −15 credit per rating's rater                           |
| APPEAL | `UPHOLD`  | unchanged, owner notified                                         |
| APPEAL | `REVOKE`  | → `VOID`, counters down, −15 credit for the rater, owner notified |

The deduction uses `CreditService` with idempotency key
`note-rating-void:<ratingId>`, so a rating is penalised at most once. A rater who
drops below 90 loses rating rights through the eligibility check. Only the first
admin to resolve a case wins (`NOTE_RATING_CASE_RESOLVED` for the rest).

## Visibility

Counters (`goodCount` / `badCount` on note summaries, details and
`POST /note/source-states`) are public. The owner's bad-rating list returns
reason, text, time, status and appeal state, never the rater. Admin cases include
the rater, their credit and registration date.

## Deferred

Collusion (mutual-boost) detection, one-account-per-device deduplication and
owner-level reputation that survives reposting (spec §7.2, §11).
