# Phase 6 — Fixes Applied

> Companion to [`07-trace.md`](./07-trace.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **175 tests pass** (173 + 2 new).
> Scope rule: fix everything **code-only, non-contract-breaking, no migration**.

---

## ✅ Applied (5 findings + tests)

| # | Sev | Location | Change |
|---|---|---|---|
| 1 + 3 | MED | `trace.service.ts` `toggleLike` | Rewrote the whole method inside `runSerializableTransaction` (the playbook §2 shared util). The like-row lookup, the `deleted` flip / create, and the `likeCount` increment are now one atomic, retried unit — concurrent toggles can no longer double-increment `likeCount` (#1), and a double-tap new-like serializes instead of escaping a raw `P2002` 409 (#3). The returned `likeCount` is the real post-update DB value, not a stale read ± 1 |
| 2 | MED | `trace.service.ts` `getFeed` + `toTraceDto` | `isLikedByMe` no longer derived from the truncated 20-row `likeStats` preview. `getFeed` issues one authoritative `traceLikeStat.findMany` for the viewer across the page's trace ids; `toTraceDto` takes a `likedTraceIds` Set |
| 4 | MED | `trace.service.ts` `createTrace` | `dto.images` validated via the shared `assertUrlsFromStorage` — off-origin image URLs (a cross-user tracking/phishing vector on the friend feed) are rejected. `TraceService` now injects `ConfigService` |
| 9 | LOW | `trace.service.ts` `deleteTrace` | `trace.update` `where` widened to `{ id, fromID, deleted: false }` — TOCTOU hardening, consistent with the note module |
| 7 | LOW | `trace.controller.ts` | 7× `@Req() req: any` → `RequestWithUser` |

### Tests (2 new, `trace.service.spec.ts`)

- `toggleLike increments likeCount atomically and returns the DB value` — verifies the new-like path and that the returned count is the `trace.update` result.
- `toggleLike on an existing like unlikes and decrements`.
- Added `ConfigService` provider + `traceLikeStat.findMany` to the test mock; seeded `traceLikeStat.findMany → []` in the feed test.

---

## ⏸️ Deferred — full inventory of unfixed Phase 6 findings

| # | Sev | Why deferred |
|---|---|---|
| 5 | MED | `UserTracePreference` (HIDE) is a dead feature — model + enum exist, but the feed never filters by it and there is no "hide moment" endpoint. Implementing it is net-new functionality (`POST /trace/:id/hide` + a `NOT { preferences: { some: … } }` clause). Feature work, not a bug fix |
| 6 | LOW | `PUBLIC` visibility is in the enum + the feed `where`, but `CreateTraceDto` only allows `FRIENDS_ONLY`/`PRIVATE` so it can never be created. Whether to expose public moments is a product decision; the feed branch is harmless dead code until then |
| 8 | LOW | Dead schema fields (`Trace.title` / `latitude` / `longitude` / `viewCount`, `traceViewedStat`, `TraceComment.images`) — removing them is a migration; implementing them is feature work |
| 10 | LOW | `deleteComment` soft-deletes a comment without touching child replies, so a reply can show "reply to <deleted comment>". A behavior decision (cascade-soft-delete vs. show a tombstone) — left for product |

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       175 passed, 175 total      (was 173 before this patch)
```
