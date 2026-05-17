# Phase 2a — Fixes Applied

> Companion to [`03a-friend-core.md`](./03a-friend-core.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **149 tests pass** (147 + 2 new).
> Scope rule for this batch: fix everything that is **security/correctness-relevant, code-only, and does not break the API contract or need a migration**. Migration / product-decision / frontend-coordination items are deferred with reasons.

---

## ✅ Applied (9 findings)

| # | Sev | Location | Change |
|---|---|---|---|
| 1 | HIGH | `friend.service.ts` `sendRequest` | The `Friend` table has no `@@unique`, so the check-then-insert raced. Moved the duplicate check **inside** the `$transaction` and prefixed it with a Postgres **transaction-scoped advisory lock** keyed on the sorted user-pair (`pg_advisory_xact_lock(hashtext('friend:a:b'))`). Concurrent `sendRequest` calls for the same pair now serialize — the second sees the first's PENDING row and gets a clean `ConflictException`. No new dependency, no schema change |
| 2 | HIGH (race part) | `friend.service.ts` `blockUser` | Wrapped the block `$transaction` in `try/catch`; a P2002 from the find-then-create race is now mapped to `ConflictException('User already blocked')` instead of leaking the Prisma constraint field names through `PrismaExceptionFilter` |
| 5 | HIGH | `friend.service.ts` `handleRequest` | Accept path now refetches the sender (`record.userID`) and throws `NotFoundException('The requester is no longer available')` if they are not `ACTIVE` — a banned/deleted sender can no longer be turned into a live friendship by the recipient |
| 7/10 | MED | `friend.dto.ts` `SendFriendRequestDto` | Added `@ArrayMaxSize(20)` to `tagIds` — caps the staged-tag fan-out, closes the "send 10k tag UUIDs" DoS vector |
| 9 | MED | `friend.dto.ts` `ReportFriendDto` | Added `@Matches(/^[^<>]+$/, { each: true })` to `evidence` — rejects angle brackets so a report cannot smuggle HTML/script markup into a moderator console |
| 12 | MED | `friend.controller.ts` | All 14 `@Req() req: any` → `@Req() req: RequestWithUser` (the type introduced in Phase 1) |
| 13 | MED | `friend.service.ts` `handleRequest` + `cancelRequest` | Both now `deleteMany` the `pendingFriendTagOnRequest` rows for the request once it leaves `PENDING` (promoted on accept, irrelevant on reject/withdraw) — no more orphan staged-tag rows |
| 17 | LOW | `friend.dto.ts` | Deleted the unused `HandleFriendRequestDto` (controller uses dedicated `/accept` + `/reject` routes; confirmed zero call sites) |
| 24 | LOW | `friend.service.ts` `getStatus` | Block + friend lookups now run in `Promise.all` instead of sequentially |

### Tests

- Added `$executeRaw: jest.fn()` to the `friend.service.spec.ts` prisma mock and the inline `tx` mock used by the sendRequest atomicity test (advisory lock call).
- Added `pendingFriendTagOnRequest.deleteMany` to the cancelRequest / accept / reject inline `tx` mocks (#13 cleanup call).
- Added sender-status / friend-count mocks to the accept tests that previously didn't need them.
- **2 new test cases**:
  - `rejects accepting a request whose sender is no longer active` (verifies #5)
  - `maps a concurrent block race (P2002) to a clean conflict` (verifies #2)

> Note: the 3 pre-existing "translates a concurrent duplicate … P2002" tests still pass — they now also exercise a *real* path, since the in-transaction recheck + advisory lock is the authoritative guard and `friend.create` failing is the defense-in-depth fallback.

---

## ⏸️ Deferred — full inventory of unfixed Phase 2a findings

### Needs a DB migration (deferred to a dedicated migration PR)

| # | Sev | Why deferred |
|---|---|---|
| 3 | HIGH | `backfillLegacyActivitiesForViewer` runs on every inbox read. The proper fix needs a `User.activitiesBackfilledAt` column so it runs once. That's a schema migration + the backfill ideally becomes an offline job — a design change, not a Phase-2a-style patch. The advisory-lock and other fixes don't depend on it |
| 6 | MED | `reportFriend` dedup is TOCTOU. Proper fix = `@@unique([reporterID, targetID, category])` on `FriendReport` + `try create / catch P2002`. Needs a migration. Practical impact is low: reports are rate-limited (10/hr) and a duplicate just yields two identical rows a moderator sees — no corruption |
| 16 | MED | Concurrent `backfill` could double-insert activities. A real fix needs `@@unique([requestId, viewerId, type])` on `FriendActivity` so `createMany({ skipDuplicates: true })` is meaningful (`skipDuplicates` is a no-op without a unique index). Bundle with #3's migration |

### Needs product / frontend coordination

| # | Sev | Why deferred |
|---|---|---|
| 4 | HIGH | List endpoints (`listFriends` / `listIncoming` / `listOutgoing` / `listBlocked`) have no pagination. Adding it changes the response shape (`FriendProfileDto[]` → paginated envelope) — a breaking contract change the frontend must coordinate on. A silent cap would be worse than the current behavior. Needs an API-design decision |
| 8 | MED | Inactive friends are hidden from list responses but still counted by `assertBelowFriendLimit` → UI shows N-1 while quota says N, and the friendship can't be re-established. The fix (consistent counting or archiving inactive friendships) is a data-model decision |
| 11 | MED | `blockUser` hard-deletes Friend rows of *all* states. "Clean slate on block" is a defensible product choice — changing it to preserve REJECTED/WITHDRAWN history needs product confirmation |
| 14 | MED | `removeFriend` writes no activity / sends no notification to the counterparty. Whether a removal should notify is a product decision |
| 15 | MED | `assertBelowFriendLimit` treats `ADMIN` like `MEMBER` for the higher friend cap, conflating an auth role with a subscription tier. The clean fix is a separate `subscription`/`tier` field — a data-model + product decision |

### `#2` OpenIM half — deferred to Phase 8

`blockUser` does not revoke the OpenIM relationship, so the IM channel stays open after a block. Fixing it means injecting `OpenimService` and adding a relationship-removal call — best done while reviewing the OpenIM module (Phase 8), where its failure modes and retry story are in scope.

### LOW cosmetic / refactor — deferred to Phase 9 cross-cutting

| # | Item |
|---|---|
| 18 | `friend.controller.ts` imports `FriendState` from generated Prisma — controller should use a domain type |
| 19 | Three near-identical "find target user + ACTIVE check" blocks (`sendRequest` / `reportFriend` / `blockUser`) — extract a helper |
| 20 | Block double-direction `OR` query could be two composite-key `findUnique`s |
| 21 | `sendRequest` "already friends" detection logic is duplicated with `throwActiveFriendConflict` |
| 22 | `listMyTags` has no pagination (low risk — tag counts are small) |
| 23 | 4× `users.findMany + Map + filter + map` could be one `attachUsers()` helper |
| 25 | `sendRequest` success log lacks a `requestId` |
| 26 | Hard-coded English error strings — i18n later |
| 27 | `FriendProfileDto` fields have no `@Expose` (only matters if `@Serialize` is added later) |
| 28 | The 3 P2002 tests still exercise a mock-forced path — kept as defense-in-depth documentation |
| 30 | `requestData` typed `as any` — could use `Prisma.FriendCreateInput` |

---

## 🚨 Required follow-up actions (user)

1. **`#1` works only on PostgreSQL** — `pg_advisory_xact_lock` is Postgres-specific. The project already uses `@prisma/adapter-pg`, so this is fine; just be aware if the DB ever changes.
2. The deferred migration items (#3, #6, #16) should be batched into **one migration PR** that adds: `User.activitiesBackfilledAt`, `FriendReport @@unique([reporterID,targetID,category])`, `FriendActivity @@unique([requestId,viewerId,type])` — then the corresponding service code can be tightened (`skipDuplicates`, try/catch, one-time backfill gate).
3. Decide the **pagination contract** for friend list endpoints (#4) with the frontend team before that becomes a production incident for high-degree users.

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       149 passed, 149 total      (was 147 before this patch)
```
