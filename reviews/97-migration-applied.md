# Migration Applied — `20260516000000_maturity_constraints`

> Playbook `98-maturity-playbook.md` §3 (DB-level invariant backstops) + §6 step ③ (code adoption).
> **Verification**: migration applied to the dev DB · `npx tsc --noEmit` 0 errors · `jest` 28 suites / **173 tests pass**.

---

## 1. The migration

`prisma/migrations/20260516000000_maturity_constraints/migration.sql` — all statements
additive and **idempotent** (`IF NOT EXISTS`).

| Object | Kind | Backs which finding |
|---|---|---|
| `User.activitiesBackfilledAt` | column | friend 2b#1 — one-time backfill gate |
| `CoinGift.idempotencyKey` | column | coin 3#1 — gift idempotency |
| `FriendReport_reporterID_targetID_category_key` | unique index | friend 2a#6 — duplicate-report TOCTOU |
| `FriendActivity_requestId_viewerId_type_key` | unique index | friend 2b#6 — concurrent backfill double-write |
| `CoinGift_idempotencyKey_key` | unique index | coin 3#1 — idempotency enforcement |
| `Friend_active_pair_key` | **partial** unique (`WHERE state IN (PENDING,ACCEPTED)`, `LEAST/GREATEST`) | friend 2a#1 — duplicate active friendship |
| `CircleInvitation_pending_applicant_key` | **partial** unique (`WHERE status='PENDING'`) | circle 5#6 — duplicate pending invitation |
| `NoteGroup_owner_name_active_key` | **partial** unique (`WHERE deletedAt IS NULL`) | note 4a#2 — duplicate live group name |

`schema.prisma` carries the two columns + the three plain `@@unique` declarations.
The three **partial** uniques cannot be expressed in `schema.prisma` (Prisma has no
`WHERE` on `@@unique`) — they live only in the migration SQL.

### How it was applied (not the normal `migrate dev` path)

Two real-world obstacles, both worked around without data risk:

1. **Shadow DB replay fails** — the pre-existing migration `20260408170000_friend_activities`
   errors in isolation (`type "FriendState" does not exist`). So `prisma migrate dev`
   (which needs a shadow DB) is unusable on this repo. → Used `prisma migrate diff`
   (schema-to-schema, no DB) to generate the SQL, then `prisma migrate deploy`
   (no shadow DB) to apply.
2. **The dev DB is diverged** — it carries tables/indexes from a parallel branch
   (`IconAsset`, `UserCollection`, and even a pre-existing `Friend_active_pair_key`).
   A diff *against the live DB* would have generated destructive `DROP`s. → Diffed
   `git HEAD:schema.prisma` → new `schema.prisma` instead, yielding only additive SQL;
   made every statement `IF NOT EXISTS` so the objects the other branch already created
   are silently skipped. The first apply hit the pre-existing `Friend_active_pair_key`;
   after `migrate resolve --rolled-back` + the idempotent rewrite, the re-apply
   completed all 8 objects.

> ⚠️ The dev DB being diverged is itself a finding — it is a shared, multi-branch
> database. Treat it with care; production should be migrated from a clean state.

---

## 2. Code adoption (playbook §6 step ③)

With the constraints in place, the SELECT-then-INSERT patterns now have a real backstop:

| Module | Change |
|---|---|
| `coin.controller.ts` | `POST /coin/gift` now requires an `Idempotency-Key` header (`@Headers` + presence check + `@ApiHeader` doc) |
| `coin.service.ts` `sendGift` | Takes `idempotencyKey`; fast-path `coinGift.findUnique` short-circuits a known key; stores the key on `coinGift.create`; `catch P2002` turns the concurrent-retry race into an idempotent success (no double-charge) |
| `friend.service.ts` `reportFriend` | Kept the friendly `findFirst` pre-check; added `catch P2002` so the race-loser also gets a clean `ConflictException` |
| `friend.service.ts` `createFriendActivities` + backfill | `createMany({ skipDuplicates: true })` — meaningful now that `FriendActivity` has the unique index |
| `friend.service.ts` `backfillLegacyActivitiesForViewer` | Gated on `User.activitiesBackfilledAt` — runs once per user, then stamps the column. Eliminates friend 2b#1 (the full scan on every polled `listActivities` / `getUnreadActivityCount`) |
| `note.service.ts` `createGroup` / `updateGroup` | `catch P2002` → `ConflictException` (race backstop behind the existing name pre-check) |

`Friend` `sendRequest` and `CircleInvitation` `invite` already had advisory locks
(added in earlier phases); the new partial uniques are defense-in-depth behind them —
no code change needed there.

### Tests

- `coin.service.spec.ts`: every `sendGift` call updated to pass an idempotency key;
  new test `is idempotent: a reused idempotencyKey does not charge again`.
- `friend.service.spec.ts`: `createMany` assertions updated for `skipDuplicates: true`;
  backfill test seeds `user.findUnique → { activitiesBackfilledAt: null }` so the
  one-time gate lets the scan run.

---

## 3. Follow-up for the user

1. **Apply the migration to staging/production** with `prisma migrate deploy`. It is
   idempotent, so re-running is safe. Before applying, confirm no duplicate rows exist
   for the new uniques — on the dev DB there were none (checked: 0 dups across all 5
   constrained shapes).
2. **Frontend**: `POST /coin/gift` now **requires** the `idempotency-key` header — the
   client must generate a unique key per gift attempt and reuse it on retry. Without it
   the request is `400`.
3. The partial-unique indexes are invisible to Prisma — a future `prisma migrate dev`
   would try to "fix drift" by dropping them. Until the shadow-DB migration history is
   repaired, stay on `migrate deploy` + hand-authored migrations (which this repo already
   effectively does).

---

## Verification log

```
$ npx prisma migrate deploy
Applying migration `20260516000000_maturity_constraints`
All migrations have been successfully applied.

$ (index check) => 6/6 unique indexes present, 2/2 columns present

$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       173 passed, 173 total
```
