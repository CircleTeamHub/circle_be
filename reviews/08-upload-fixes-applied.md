# Phase 7 — Fixes Applied

> Companion to [`08-upload.md`](./08-upload.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **175 tests pass**.
> Scope rule: fix everything **code-only, non-contract-breaking, no migration**.

---

## ✅ Applied (4 findings)

| # | Sev | Location | Change |
|---|---|---|---|
| 2 | MED | `upload.service.ts` `onModuleInit` | Wrapped `ensureBucketExists` + `ensureBucketIsPublicReadable` in `try/catch` — a MinIO outage at boot now logs an error and lets the app start (degraded), instead of crashing the whole process. `presign` still returns a clean 503 to callers |
| 3 | MED | `upload.controller.ts` | The per-user presign counter `Map` now has a `sweepExpiredPresignCounts` pass (amortized, at most once per window) that drops expired entries — the Map can no longer grow one-entry-per-user-forever |
| 6 | LOW | `upload.controller.ts` | `@Req() req: any` → `RequestWithUser` |
| 7 | LOW | `upload.service.ts` `presign` | Extension extraction gated on an actual `.` — a filename with no dot (e.g. `avatar`) now yields `bin` instead of using the whole filename as the extension |

---

## ⏸️ Deferred — full inventory of unfixed Phase 7 findings

| # | Sev | Why deferred |
|---|---|---|
| 1 | MED | No upload **size limit**. `getSignedUrl(PutObjectCommand)` cannot enforce a content-length range — the only fix is switching to `createPresignedPost` with `content-length-range`, which changes the presign **response shape** (the client uploads via a POST form instead of a `PUT`). That is an API-contract change requiring frontend coordination. **This is the most important deferred item** and should be the next upload work |
| 4 | MED | No object-delete capability → the note module's S3 orphans (4a #3/#4) can't be cleaned. A naive "delete on note update/delete" is unsafe: two notes could reference the same `objectKey`, so deleting one would break the other. The reference-safe fix is a background GC job that deletes objects unreferenced by **any** `NoteMedia` row after a grace period — a design task, not a quick patch. Adding an unused `deleteObject()` method now would just be dead code |
| 5 | MED | The whole bucket is `public-read`, so `notes/{userId}/` private-note media is world-readable (mitigated only by the unguessable UUID key). Switching to prefix-scoped policy (`avatars/* covers/* posts/*` public, `notes/*` private + signed read URLs) is a product decision about how private "private notes" must be |
| 8 | LOW | `contentType` is not cross-checked against the `filename` extension. Cosmetic, and an over-strict check would reject legitimately-mismatched files — left as-is |
| 9 | LOW | `ensureBucketExists`'s bare `catch {}` conflates "bucket missing" with auth/network errors. Now that #2 wraps the whole bootstrap in a logging `try/catch`, a genuine auth failure surfaces in the logs anyway — the residual imprecision is cosmetic |

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       175 passed, 175 total
```
