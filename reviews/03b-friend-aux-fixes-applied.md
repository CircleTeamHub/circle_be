# Phase 2b — Fixes Applied

> Companion to [`03b-friend-aux.md`](./03b-friend-aux.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **157 tests pass** (149 + 8 new).
> Scope rule: fix everything **code-only, non-contract-breaking, no migration**. Migration / API-contract / cosmetic items deferred with reasons.

---

## ✅ Applied (5 findings + tests)

| # | Sev | Location | Change |
|---|---|---|---|
| 2 | MED | `friend.service.ts` `createTag` | Added `MAX_FRIEND_TAGS_PER_USER = 50` cap. `createTag` now `findUnique`s the name first — only a **new** tag triggers a `count` check; an existing-name resubmission stays an idempotent color update and is never blocked |
| 3 | MED | `friend.controller.ts` `POST /tags` | `@ApiOperation` summary corrected to **"Create or update a friend tag (idempotent by name)"** with a description noting that re-submitting a name updates its color. The endpoint behaviour is unchanged (upsert); the docs no longer lie about it |
| 8 | LOW | `friend.service.ts` `removeTag` | Now fetches the tag in parallel with the friendship and rejects a foreign / missing `tagId` with `NotFoundException` — parity with `assignTag`, which already did this. No longer a silent no-op |
| 9 | LOW | `friend.service.ts` `unblockUser` | Replaced find-then-delete (2 queries) with a single `block.delete` wrapped in `try/catch`; a `P2025` (record not found) maps to `NotFoundException('Block not found')` |
| 11 | LOW | `friend.dto.ts` `CreateFriendTagDto` | Added `@IsNotEmpty()` to `name` — truly-empty strings are rejected at the DTO boundary (the service `trim()` check still covers whitespace-only) |

Supporting refactor: extracted `prismaErrorCode(error)` helper; `isPrismaUniqueConstraintError` now delegates to it, and `unblockUser` reuses it for the `P2025` check.

### Tests (8 new, `friend.service.spec.ts`)

- `createTag rejects an empty (whitespace-only) tag name`
- `createTag rejects a new tag once the per-user limit is reached`
- `createTag still allows updating an existing tag at the limit` (verifies the cap doesn't block idempotent updates)
- `assignTag rejects a tag that does not belong to the user`
- `removeTag now rejects a foreign tag id instead of silently no-op` (verifies #8)
- `setRemark writes remarkB when the caller is the friendID side`
- `getActivity does not leak another viewer activity` (verifies viewer-scoped lookup)
- `unblockUser maps a missing block (P2025) to a 404` (verifies #9)

Extended the spec's `friendTag` prisma mock with `findUnique` / `count` / `delete`.

---

## ⏸️ Deferred — full inventory of unfixed Phase 2b findings

### Needs a DB migration (bundle into the friend-module migration PR with 2a #3/#6/#16)

| # | Sev | Why deferred |
|---|---|---|
| 1 | HIGH | `backfillLegacyActivitiesForViewer` runs on every `listActivities` / `getUnreadActivityCount`. Proper fix needs a `User.activitiesBackfilledAt` column so it runs once, then becomes an offline script. GET-with-side-effects + full-scan-on-poll can't be fixed without that flag |
| 5 | MED | backfill only restores **one** activity per legacy request — restoring the full history (multiple activities per request) only makes sense once the backfill itself is reworked into the one-time job from #1 |
| 6 | MED | concurrent backfill double-writes activities; needs `FriendActivity @@unique([requestId, viewerId, type])` + `createMany({ skipDuplicates: true })` |
| 12 | LOW | `createFriendActivities` `skipDuplicates` is a no-op without the `@@unique` from #6 — same migration |

### Needs API-contract / frontend coordination

| # | Sev | Why deferred |
|---|---|---|
| 4 | MED | No pagination on `listActivities` / `listMyTags` / `listFriendsByTag` / `listBlocked`. Adding it changes the response shape — must be coordinated with the frontend (same call as 2a #4). `listActivities` is the urgent one since the activity table grows unbounded |

### Cosmetic / low-value (Phase 9 cross-cutting)

| # | Item |
|---|---|
| 7 | `listTags` returns raw Prisma rows (includes `createdAt`) instead of a serialized `FriendTagDto`. Fixing needs `@Expose` decorators on `FriendTagDto` + `@Serialize` — a (minor) response-shape change; the leaked field is the user's own `createdAt`, not sensitive |
| 10 | `friendsSince` / settings `remark` are derived from `Friend.updatedAt`, which drifts when a remark or tag is edited. A correct fix needs a dedicated `acceptedAt` column (migration) |
| 13 | `markActivityRead` returns success for an already-read activity (idempotent) without distinguishing "just marked" vs "already read" — not a bug, no fix needed |
| 14 (partial) | Test coverage was expanded for the touched paths; `deleteTag` / `listFriendsByTag` (inactive-filter) / `getUnreadActivityCount` / `markActivityRead` 404-path still lack dedicated tests — backlog |

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       157 passed, 157 total      (was 149 before this patch)
```
