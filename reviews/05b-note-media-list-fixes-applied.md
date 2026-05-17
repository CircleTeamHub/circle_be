# Phase 4b — Fixes Applied

> Companion to [`05b-note-media-list.md`](./05b-note-media-list.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **170 tests pass** (168 + 2 new).
> Scope rule: fix everything **code-only, non-contract-breaking, no migration**.

---

## ✅ Applied (2 findings + tests)

| # | Sev | Location | Change |
|---|---|---|---|
| 1 | MED | `note.service.ts` `assertMediaUrlsAreSafe` (new) | New guard rejects media whose `url` / `posterUrl` is not served from `MINIO_PUBLIC_URL`. Called in `createNote` + `updateNote` right after `assertMediaOwnership`. The check requires the prefix to be followed by `/` (`url === prefix \|\| url.startsWith(prefix + '/')`) so it is **not** vulnerable to the `https://host.attacker.com` bypass that a bare `startsWith` allows. Skipped when MinIO is unconfigured (upload disabled anyway). `NoteService` now injects `ConfigService` |
| 5 | LOW | `note.dto.ts` `CreateNoteMediaDto.objectKey` | Added `@Matches(/^(?!.*\.\.)[A-Za-z0-9._/-]+$/)` — restricts to a safe storage-key charset and rejects any `..` sequence |

### Tests (2 new, `note.service.spec.ts`)

- `rejects media whose url is not served from app storage when MinIO is configured` — constructs `NoteService` with `MINIO_PUBLIC_URL` set, sends media with `url: https://evil.example.com/...` and a legit `objectKey`, asserts `BadRequestException` and that no transaction runs.
- `accepts media whose url is under MINIO_PUBLIC_URL` — same setup, url under the configured origin, succeeds.
- Updated the `beforeEach` `TestingModule` to provide a `ConfigService` mock (returns `null` → existing tests skip the new check, behaviour unchanged).

---

## ⏸️ Deferred — full inventory of unfixed Phase 4b findings

| # | Sev | Why deferred |
|---|---|---|
| 2 | MED | Media metadata (`type` / `mimeType` / `size` / `width` / `height` / `durationMs`) is fully client-trusted; the server never verifies the S3 object's real content-type or size. The robust fix records the presigned key's true metadata at presign time and cross-checks at note-create — cross-module work for Phase 7 (upload). The most dangerous slice of #2 — a `url` pointing off-origin — is **already closed by #1** |
| 3 | MED | `listNotes` `search` uses `contains` with no trigram/full-text index. A real fix is a `pg_trgm` GIN index on `Note.title` / `content` (migration). Per-user note counts are small, so this is a deferred perf item, not urgent |
| 4 | LOW | `listNotes` returns a bare array with no `total` / `hasMore`. Adding pagination metadata changes the response envelope — coordinate with the frontend alongside the other list-endpoint pagination items (friend Phase 2, coin Phase 3) |
| 6 | LOW(partial) | Added tests for the media-url guard; `listNotes` groupId/search/pagination paths and `assertMediaOwnership` rejection still lack dedicated tests — backlog |

### Note on #1's severity

`05b` flagged #1 as "MED, can escalate to HIGH once circle-plaza surfaces notes to other users." The fix closes it at the source (server-side write-time validation), so the escalation path is now blocked regardless of how Phase 5 circle-plaza exposes notes. Phase 5 should still confirm circle-plaza does not have its own media-rendering path that bypasses `NoteService`.

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       170 passed, 170 total      (was 168 before this patch)
```
