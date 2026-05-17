# Phase 5 — Fixes Applied

> Companion to [`06-circle.md`](./06-circle.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **172 tests pass** (170 + 2 new).
> Scope rule: fix everything **code-only, non-contract-breaking, no migration**. Feature-additions, product decisions and migration items deferred.

---

## ✅ Applied (8 findings + tests)

| # | Sev | Location | Change |
|---|---|---|---|
| 1 | MED | `circle.service.ts` `assertAvatarUrlIsSafe` (new) + `circle-plaza.service.ts` `assertImagesAreSafe` (new) | Circle `avatarUrl` and plaza post `images[]` are now validated against `MINIO_PUBLIC_URL` (prefix must be followed by `/`). Off-origin URLs — a cross-user tracking/phishing vector on the shared feed — are rejected. Both services now inject `ConfigService`. Skipped when MinIO unconfigured |
| 2 | MED | `circle.dto.ts` + `circle.service.ts` `createCircle` | Added `isPublic?: boolean` to `CreateCircleDto`; `createCircle` now passes `dto.isPublic ?? true`. The previously-dead "private circle + PENDING join" path in `joinCircle` is now reachable |
| 6 | MED | `circle-invitation.service.ts` `invite` | `CircleInvitation` has no DB unique constraint; the "no existing PENDING invitation" check is now **inside** the transaction, preceded by a Postgres transaction-scoped advisory lock keyed on `(circleID, applicantID)` — concurrent invites for the same pair serialize instead of producing duplicates |
| 7 | MED | `circle-invitation.service.ts` | `getMyPendingVerifications` / `getMyApplications` / `getPendingInvitationsForCircle` rewritten from `Promise.all(ids.map(loadInvitation))` (N+1) to a single `findMany` with a shared `INVITATION_INCLUDE`. `loadInvitation` also reuses the constant |
| 13 | LOW | `circle-invitation.service.ts` `addVerifier` | Error message corrected — "该好友不在本圈子" (implied a friend requirement that the code never checks) → "验证人必须是本圈子的活跃成员" |
| 14 | LOW | `circle.service.ts` `joinCircle` | The transaction retry loop now maps a `P2002` (concurrent join winning the race between the pre-check and the create) to a clean `ConflictException` instead of a leaked Prisma constraint error |
| 11 | LOW | `circle.dto.ts` `maxMembers` | Removed the misleading `@ApiPropertyOptional({ default: 500 })` — the real behaviour when omitted is `null` (no limit). Swagger now says "omit for no limit" |
| 10 | LOW | 3 controllers | `@Req() req: any` → `RequestWithUser` across `circle` / `circle-invitation` / `circle-plaza` controllers (~19 sites) |

### Tests (2 new)

- `circle.service.spec.ts`: `rejects createCircle with an off-origin avatarUrl when MinIO is configured`
- `circle-plaza.service.spec.ts`: `rejects a post with off-origin images when MinIO is configured`
- Added `ConfigService` mock to the `circle` and `circle-plaza` test modules; added `$executeRaw` to the `circle-invitation` prisma mock (advisory lock).

---

## ⏸️ Deferred — full inventory of unfixed Phase 5 findings

### Feature additions (out of scope for a bug-fix pass)

| # | Sev | Why deferred |
|---|---|---|
| 3 | MED | No delete-circle / transfer-owner endpoint. Adding these is net-new functionality + product policy (what happens to members/posts on circle deletion). `Circle.deleted` exists but is unused — wiring it needs the endpoint design |
| 5 | MED | `deletePost` is author-only; circle owner/admin moderation is a new capability + a policy decision (who can moderate, audit trail) |
| 12 | LOW | `CirclePost.viewCount` is never incremented — implementing view tracking is a feature (and raises its own concurrency question) |
| 15 | LOW | A plaza post's embedded `noteId` has no read path for non-authors (`getNote` is owner-only). Surfacing embedded notes to circle viewers is a feature with its own authz design |

### Needs a product decision

| # | Sev | Why deferred |
|---|---|---|
| 4 | MED | `getFeed` has no membership filter — every circle's posts are readable by every user. This is either intended ("plaza = public square") or a privacy leak, depending on the product model. Now that `isPublic` is wired (#2), the intended rule can finally be expressed; needs PM confirmation before adding a filter |

### Cross-cutting / migration

| # | Sev | Why deferred |
|---|---|---|
| 8 | MED | `Circle.memberCount` drift. Note: with the current code users are only **soft-deleted** (`status: DELETED`), so the `onDelete: Cascade` on `CircleMember` never actually fires — the drift scenario from the review is latent, not active. The real issue (soft-deleted users staying counted as circle members) belongs with the Phase 9 cross-cutting "what happens to a user's relationships on account deletion" question. The maturity playbook (`98-maturity-playbook.md` §4) recommends moving to `_count`-based counts |
| 9 | MED→withdrawn | The review flagged adding injection guards to plaza `content` / circle `description`. On reflection this is the **wrong fix**: those are legitimate free-text fields (5000-char post body, circle description) where rejecting `<` / `>` at input would break valid content. The correct mitigation is output-encoding at render time (frontend responsibility). Backend `<>`-rejection only makes sense for short identifier-ish fields (objectKeys, gift messages) — not free text. Reclassified as a frontend concern |

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       172 passed, 172 total      (was 170 before this patch)
```
