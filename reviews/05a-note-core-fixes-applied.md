# Phase 4a — Fixes Applied

> Companion to [`05a-note-core.md`](./05a-note-core.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **168 tests pass** (167 + 1 new).
> Scope rule: fix everything **code-only, non-contract-breaking, no migration**.

---

## ✅ Applied (3 findings + test)

| # | Sev | Location | Change |
|---|---|---|---|
| 1 | MED | `note.service.ts` `deriveNoteContent` | Title/content derived from `contentJson` blocks now `.slice()` to `MAX_NOTE_TITLE_LENGTH = 120` / `MAX_NOTE_CONTENT_LENGTH = 20_000` — the same caps the DTO `@MaxLength` enforces for the non-block path. A huge first text block can no longer write an unbounded `Note.title` / `Note.content` |
| 8 | LOW | `note.service.ts` `deleteNote` | `note.update` `where` changed from `{ id }` to `{ id, ownerID, status: { not: 'DELETED' } }` — closes the TOCTOU window, for parity with `setPinned` / `setAvailable` |
| 6 | LOW | `note.controller.ts` | 11× `@Req() req: any` → `RequestWithUser` |

### Tests

- New: `truncates contentJson-derived title and content to the DTO caps` — sends a 50 000-char text block and asserts `note.create` receives `title.length === 120` and `content.length === 20000`.
- Updated: `soft deletes a note` — the `note.update` `where` assertion now includes `ownerID` + `status` (#8).

---

## ⏸️ Deferred — full inventory of unfixed Phase 4a findings

### Needs a DB migration

| # | Sev | Why deferred |
|---|---|---|
| 2 | MED | `NoteGroup` name uniqueness is TOCTOU — the correct fix is `@@unique([ownerID, name])` (migration) + `catch P2002`. The `MAX_GROUPS_PER_USER` count check is also racy but the overshoot is 1–2 groups — harmless. Bundle the unique constraint into the project's pending migration PR |
| 7 | LOW | `Note.groupID` is a dead column (`createNote`/`updateNote` always write `null`; the m2m `NoteGroupMembership` is the real link). Dropping it + its `@@index` is a migration |

### Needs cross-module work (S3 / upload — Phase 7)

| # | Sev | Why deferred |
|---|---|---|
| 3 | MED | `updateNote` deletes + recreates all `NoteMedia` rows on every PATCH, orphaning the previous rows' S3 objects. A real fix = diff media by `objectKey` + hand removed keys to an S3 cleanup path. That cleanup belongs with the upload module review (Phase 7); the diff itself is a non-trivial refactor |
| 4 | MED | `deleteNote` soft-deletes the note but leaves `NoteMedia` rows + S3 objects orphaned. Same S3-GC dependency as #3 — needs an object-cleanup mechanism that doesn't exist yet |

### Lower value

| # | Item |
|---|---|
| 5 | `contentJson` array elements (`Record<string, unknown>`) are unvalidated. The traversal helpers already guard `depth > 10`, the request body size is bounded by Express, and #1's truncation removes the derived-content explosion — residual risk is low. A structural validator (per-block size / depth at the DTO layer) can come later |
| 9 | `createGroup` `sortOrder: groupCount` can collide under concurrent creates — no harm, just unordered display until the next `reorderGroups` |
| 10 | `reorderGroups` has a small TOCTOU window (count → ownership → transaction). The transaction updates by id so it stays safe; only a concurrent add/remove makes the reorder stale |

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       168 passed, 168 total      (was 167 before this patch)
```
