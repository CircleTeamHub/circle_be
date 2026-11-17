# Upload Intent GC Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track public presigned uploads, atomically claim them when the five eager-upload flows persist their business rows, and safely reclaim only expired, unclaimed tracked objects.

**Architecture:** The frontend sends an optional, validated eager-upload `purpose` on only the five affected flows. `POST /upload/presign` creates an `UploadIntent` only when that purpose is present and matches its folder; old clients and every other public-media writer remain untracked and therefore ineligible for automatic deletion. Business services claim matching keys/URLs in the same Prisma transaction as their entity write. The existing daily storage audit supplies its reference inventory as a compatibility guard, while deletion uses a fresh per-key reference check plus a database lease and durable retry state so it never races a successful claim.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, AWS S3-compatible object storage, Jest, prom-client.

---

## Chunk 1: Persistence and lifecycle service

### Task 1: Add the upload-intent persistence contract

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261117090000_upload_intents/migration.sql`
- Modify: `src/upload/dto/presign.dto.ts`
- Modify: `src/upload/dto/presign.dto.spec.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `src/config/env.validation.spec.ts`
- Modify: `.env.production.example`

- [ ] **Step 1: Write failing configuration tests**

Add tests proving `UPLOAD_INTENT_GC_MODE` defaults to `report`, accepts `delete`, and rejects any other value. Add DTO tests proving the optional purpose enum accepts only `PROFILE_AVATAR`, `CIRCLE_AVATAR`, `PLAZA_POST`, `MOMENT`, and `MOMENT_COMMENT`, with a fixed purpose-to-folder mapping (`avatars` or `posts`).

- [ ] **Step 2: Run the focused env test and confirm RED**

Run: `npm test -- --runInBand src/config/env.validation.spec.ts`

Expected: assertions fail because the key is currently stripped/unknown.

- [ ] **Step 3: Add the minimal schema and migration**

Create `UploadIntentStatus` (`PENDING`, `DELETING`, `CLAIMED`, `DELETED`), `UploadIntentPurpose` (the five values above), and `UploadIntent` with unique `objectKey`, the issued `fileUrl`, `userID`, purpose, bounded `folder`, `sizeBytes`, expiry/claim/delete timestamps, deletion attempt/error fields, timestamps, and an index on `(status, expiresAt)`. Do not add a cascading user foreign key: deleting an account must not erase the only reclamation record before its object is handled.

- [ ] **Step 4: Add rollout configuration**

Validate `UPLOAD_INTENT_GC_MODE` as `report | delete`, defaulting to `report`. Declare it in `.env.production.example`; production/release Compose must inherit the mounted `.env.production` and must not add an explicit override that would shadow this value.

- [ ] **Step 5: Generate Prisma and rerun the focused test**

Run: `npx prisma generate`

Run: `npm test -- --runInBand src/config/env.validation.spec.ts`

Expected: PASS.

### Task 2: Implement tracking, transactional claiming, and leased reclamation

**Files:**
- Create: `src/upload/upload-intent.service.ts`
- Create: `src/upload/upload-intent.service.spec.ts`
- Modify: `src/upload/upload.module.ts`
- Modify: `src/metrics/upload-metrics.ts`
- Modify: `src/metrics/upload-metrics.spec.ts`

- [ ] **Step 1: Write failing service tests**

Cover: a valid explicit purpose creates a 24-hour `PENDING` intent; no-purpose and invalid purpose/folder combinations are never tracked; an own pending intent becomes `CLAIMED`; legacy keys without rows and already `CLAIMED` rows preserve existing business semantics; only `PENDING/DELETING` rows enforce uploader ownership; `DELETING`/`DELETED` own intents are rejected; referenced expired intents are durably rescued as `CLAIMED`; report mode deletes nothing; delete mode atomically leases then deletes; storage failure returns the row to `PENDING` with backoff; concurrent claim loss does not delete; expired leases are retried; terminal rows are pruned after 30 days.

- [ ] **Step 2: Run the new suite and confirm RED**

Run: `npm test -- --runInBand src/upload/upload-intent.service.spec.ts`

Expected: compile/module failure because `UploadIntentService` does not exist.

- [ ] **Step 3: Implement the smallest lifecycle service**

Use the existing `UploadService.objectKeyFromPublicUrl` for URLs and accept only raw keys matching the expected purpose/folder. `claim(tx, userID, purpose, values)` must query tracked rows, enforce owner/purpose only while `PENDING/DELETING`, reject deletion states, update pending rows inside the caller's transaction, and allow absent legacy or terminal `CLAIMED` rows to follow existing business validation. `reclaim(referenced, now)` must first rescue snapshot references as `CLAIMED`, then call a purpose-specific `isReferencedNow(intent)` immediately before `updateMany` leases the row. That method queries only the authoritative columns for the intent purpose: `User.avatarUrl`; `Circle.avatarUrl`; `CirclePost.images/videos`; `Trace.images` plus JSON attachment `key/posterKey`; or `TraceComment.images`. URL rows are returned as candidates and normalized through `UploadService.objectKeyFromPublicUrl` before comparing with `objectKey`; attachment keys compare directly. A fresh hit must persist `CLAIMED`, not merely skip the current sweep. The snapshot/fresh checks are compatibility guards, not substitutes for transaction claims. Object deletion stays outside a database transaction and write-back must match only the service's own lease.

- [ ] **Step 4: Add bounded metrics**

Add counters/gauges with only `folder`, `event`, and `mode` labels for created, claimed, rescued, due, deleted, and delete failures. Never label metrics or logs with object keys or user IDs.

- [ ] **Step 5: Run lifecycle and metrics tests to GREEN**

Run: `npm test -- --runInBand src/upload/upload-intent.service.spec.ts src/metrics/upload-metrics.spec.ts`

Expected: PASS.

## Chunk 2: Presign tracking and business claims

### Task 3: Track newly issued public upload keys

**Files:**
- Modify: `src/upload/upload.controller.ts`
- Modify: `src/upload/upload.controller.spec.ts`

- [ ] **Step 1: Write a failing controller test**

Assert that a successful presign with a valid eager purpose records `key`, authenticated user, purpose, folder, and exact size before returning; presigns without purpose never create intents; tracking failure fails the request before the client receives the signed URL.

- [ ] **Step 2: Run the controller test and confirm RED**

Run: `npm test -- --runInBand src/upload/upload.controller.spec.ts`

- [ ] **Step 3: Inject `UploadIntentService` and track the result**

Call the service only after `UploadService.presign` succeeds and only when `dto.purpose` is present. Keep the response contract unchanged; the request field is optional so old clients remain valid and untracked.

- [ ] **Step 4: Rerun the controller test to GREEN**

### Task 4: Claim media in the five eager-upload flows

**Files:**
- Modify: `src/user/user.module.ts`
- Modify: `src/user/user.service.ts`
- Modify: `src/user/__tests__/user.service.spec.ts`
- Modify: `src/circle/circle.module.ts`
- Modify: `src/circle/circle.service.ts`
- Modify: `src/circle/circle.service.spec.ts`
- Modify: `src/trace/trace.module.ts`
- Modify: `src/trace/trace.service.ts`
- Modify: `src/trace/trace.service.spec.ts`
- Modify: `src/circle-plaza/circle-plaza.module.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts`

- [ ] **Step 1: Add failing tests at each business boundary**

Assert the service calls `claim` with the matching purpose and: onboarding/profile `avatarUrl`; circle create/update/avatar `avatarUrl`; moment image URLs plus attachment `key`/`posterKey`; moment-comment image URLs; plaza post image/video URLs. Assert each claim uses the same transaction client as its entity write and that a claim failure rolls back/prevents the entity write.

- [ ] **Step 2: Run all five focused suites and confirm RED**

Run: `npm test -- --runInBand src/user/__tests__/user.service.spec.ts src/circle/circle.service.spec.ts src/trace/trace.service.spec.ts src/circle-plaza/circle-plaza.service.spec.ts`

- [ ] **Step 3: Import `UploadModule`, inject the service, and claim immediately before entity writes**

Wrap moment creation in a Prisma transaction. For existing transactions, call `claim` after authorization/validation but before the create/update. Keep side effects outside the transaction exactly as they are.

- [ ] **Step 4: Rerun focused suites to GREEN**

## Chunk 3: Audit integration and rollout safety

### Task 5: Reconcile legacy callers and run report/delete mode

**Files:**
- Modify: `src/upload/storage-audit.service.ts`
- Modify: `src/upload/storage-audit.service.spec.ts`

- [ ] **Step 1: Write failing audit integration tests**

Assert the audit passes the exact referenced-key set and current time to `UploadIntentService.reclaim`, including keys referenced by tables not yet explicitly claiming, and that audit failure still reports through the existing handled-job path.

- [ ] **Step 2: Run audit tests and confirm RED**

Run: `npm test -- --runInBand src/upload/storage-audit.service.spec.ts`

- [ ] **Step 3: Invoke tracked reclamation after reference collection**

Call `reclaim` using the already collected set; the reclaimer must repeat an exact current reference check before leasing each due key. Do not enable deletion of arbitrary bucket orphans. Update audit logging to distinguish the unchanged all-bucket report from tracked-intent reclamation.

### Task 6: Mark only the five frontend eager uploads with a purpose

**Files (frontend worktree based on current `origin/main`):**
- Modify: `src/services/api/upload.ts`
- Modify: `src/services/api/upload.spec.ts`
- Modify: `src/features/auth/screens/OnboardingProfileScreen.tsx`
- Modify: `src/features/discover/hooks/use-circle-form.ts`
- Modify: `src/features/social/screens/CreatePostScreen.tsx`
- Modify: `src/features/discover/screens/CreateMomentScreen.tsx`
- Modify: `src/features/discover/components/moment-comment-input.tsx`
- Modify: `src/features/chat/utils/chat-video-poster.ts`
- Modify: `src/features/chat/utils/chat-video-poster.spec.ts`
- Modify focused screen/hook tests as needed

- [ ] **Step 1: Write failing request-contract tests**

Assert `requestUploadPresign` sends the optional purpose unchanged, validates allowed purpose/folder pairs locally, and omits the field for all existing non-eager callers.

- [ ] **Step 2: Run the focused upload tests and confirm RED**

- [ ] **Step 3: Add the optional purpose type and annotate exactly five callers**

Use `PROFILE_AVATAR`, `CIRCLE_AVATAR`, `PLAZA_POST`, `MOMENT`, and `MOMENT_COMMENT`. Add an optional purpose argument to `uploadChatVideoPoster`; only `CreateMomentScreen` passes `MOMENT` when its poster is uploaded to `posts`, while chat and every other caller continue to omit it. Do not add purpose to notes, chat, stickers, covers, friends, admin uploads, or any other caller.

- [ ] **Step 4: Run focused tests, TypeScript, lint, and diff checks to GREEN**

- [ ] **Step 5: Create one local frontend commit**

Run: `git commit -m "fix(upload): identify eager upload intents"`

### Task 7: Verify migration, PostgreSQL concurrency, and the full affected surface

**Files:**
- Modify if needed: `docs/superpowers/plans/2026-11-17-upload-intent-gc.md`

- [ ] **Step 1: Validate generated schema and migration formatting**

Run: `npx prisma validate`

Run: `npm run migration:baseline:test` if present; otherwise run the repository's migration contract command discovered from `package.json`.

- [ ] **Step 2: Add and run a real PostgreSQL concurrency suite**

Create a `test/postgres/upload-intent-race.pg-spec.ts` suite following the repository's existing conditional PostgreSQL harness. Verify: claim wins before GC lease means delete claim count is zero; GC lease wins means the business transaction rejects and creates no entity; successful object deletion with failed state write-back is safely retried after lease expiry; migration unique/index definitions behave in PostgreSQL. If no local PostgreSQL is configured, require successful compile/collection locally and leave execution to the existing PostgreSQL CI job, explicitly reporting the skip.

- [ ] **Step 3: Run focused regression suites**

Run: `npm test -- --runInBand src/upload/upload-intent.service.spec.ts src/upload/upload.controller.spec.ts src/upload/storage-audit.service.spec.ts src/metrics/upload-metrics.spec.ts src/user/__tests__/user.service.spec.ts src/circle/circle.service.spec.ts src/trace/trace.service.spec.ts src/circle-plaza/circle-plaza.service.spec.ts`

- [ ] **Step 4: Run static and production checks**

Run: `npx tsc --noEmit --incremental false`

Run: `npm run lint`

Run: `npm run build`

Run: `git diff --check origin/main...HEAD`

- [ ] **Step 5: Review the diff for rollout and compatibility**

Confirm: no response-contract change; the request purpose is optional; only the five purpose-tagged uploads can create deletable rows; default mode is report-only; legacy/no-purpose rows are never eligible for deletion; reference reconciliation is only a compatibility guard; no object key/user ID enters logs or metric labels.

- [ ] **Step 6: Record the rolling-deploy enablement gate**

Document and follow this order: (1) apply the migration and deploy the optional-purpose/claim-aware backend in `report`; (2) confirm every old backend instance has exited, because the global whitelist pipe would reject the new field on old instances; (3) only then deploy the purpose-tagged frontend; (4) remain in `report` for at least 24 hours after the frontend release and through at least one scheduled sweep containing expired intents; (5) inspect rescued/due/error metrics and sampled database rows for false positives; (6) only then permit a separate deployment to set `delete`. The current task must not enable remote delete mode.

- [ ] **Step 7: Create one local backend commit**

Run: `git add <changed files>`

Run: `git commit -m "fix(upload): reclaim abandoned eager uploads"`

Do not push, open a PR, merge, deploy, or enable delete mode remotely without separate authorization.
