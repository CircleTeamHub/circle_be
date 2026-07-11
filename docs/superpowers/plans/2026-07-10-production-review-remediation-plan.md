# Production Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all actionable production-review findings in `feat/friend-request-annotations`, including the decision that every circle join requires approval.

**Architecture:** Keep the current NestJS/Prisma architecture and existing outbox processors. Add request-scoped PostgreSQL advisory locks for state transitions, durable delivery state for OpenIM/Expo side effects, and forward-only expand/contract migrations for the circle contract. Split implementation into four bounded units with focused tests and commits.

**Tech Stack:** NestJS 11, Prisma 7/PostgreSQL 16, Jest 30, Expo Push API, OpenIM REST API.

**Spec:** `docs/superpowers/specs/2026-07-10-production-review-remediation-design.md`

---

## Task 1: Remove public-circle semantics and make review applications consistent

**Files:**
- Modify: `prisma/schema.prisma` (CircleInvitationStatus, Circle.isPublic, invitation indexes)
- Create: `prisma/migrations/<timestamp>_circle_review_consistency/migration.sql`
- Modify: `src/circle/circle.service.ts`
- Modify: `src/circle/circle.controller.ts` and circle DTOs
- Modify: `src/circle-invitation/circle-invitation.service.ts`
- Modify: `src/common/app-error-codes.ts`
- Test: `src/circle/circle.service.spec.ts`, `src/circle-invitation/circle-invitation.service.spec.ts`
- Test: `test/*.e2e-spec.ts` or a new focused PostgreSQL integration test

- [ ] **Step 1: Write failing unit tests for the new join contract.** Assert that a new join returns HTTP 202 with an `InvitationDto`, a repeated join returns the same pending invitation, and an ACTIVE member receives the existing conflict.
- [ ] **Step 2: Run the focused circle tests and verify the new assertions fail for the current 204/PENDING implementation.**
- [ ] **Step 3: Write failing tests for legacy repair and cancellation.** Cover a PENDING member without an invitation, leaving while PENDING, and a verifier attempt after cancellation.
- [ ] **Step 4: Write failing tests for concurrent join/invite and duplicate-invitation reconciliation.** Use a real PostgreSQL test transaction where possible; assert only one PENDING invitation remains, the canonical `requiredCount` is the maximum across duplicates, and approved verifier state is preserved.
- [ ] **Step 5: Implement the minimal service/controller changes.** Remove all reads of `isPublic`, return the existing or synthesized invitation idempotently, use the shared advisory-lock key, and cancel pending invitations in the same leave transaction.
- [ ] **Step 6: Add the Deployment-A migration.** Add `CANCELLED`; synthesize legacy invitations with `inviterID=applicantID`, `requiredCount=10`, `approvedCount=0`, and `PENDING`; merge duplicate invitations using earliest `(createdAt,id)` as canonical; set canonical `requiredCount` to the maximum across duplicates; merge verifier rows with `APPROVED > PENDING > REJECTED`; recompute counts; mark every non-canonical duplicate `CANCELLED`; create the partial unique index; and leave the physical `isPublic` column present.
- [ ] **Step 7: Add and test the post-migration reconciliation command/service.** Finalize canonical invitations whose approved count reaches the requirement through the normal admission, notification, and group-sync-outbox path; return non-zero unless the threshold-met PENDING count is zero.
- [ ] **Step 8: Enumerate and remove every `isPublic` read/write from code, DTOs, fixtures, generated projections, and Swagger metadata while the physical column remains.** Run Deployment-A tests and commit this expand/behavior phase with `git commit -m "fix(circle): require review for every join"`.
- [ ] **Step 9: Add the Deployment-B contract migration that drops `isPublic` only after Deployment A is drained and reconciliation is zero.** Keep it in a separate commit `git commit -m "fix(circle): remove public circle contract"`.
- [ ] **Step 10: Run focused tests, `npx prisma validate`, and `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` for both deployment states.**

## Task 2: Make friend-request threads atomic, discoverable, and replayable

**Files:**
- Modify: `prisma/schema.prisma` and create a migration for message activity/outbox state
- Modify: `src/friend/friend.service.ts`, `src/friend/friend.controller.ts`
- Modify: `src/friend/friend.service.spec.ts`
- Modify: `src/notification/notification.service.ts`, `src/notification/notification.dto.ts`, `src/notification/notification.constants.ts`
- Modify: `src/common/app-error-codes.ts`
- Modify: `src/openim/openim.service.ts`
- Modify: existing friend outbox processor and its tests

- [ ] **Step 1: Write failing tests for the hard 50-message total limit.** Cover sender-before-reply cap, recipient cap, exact boundary, and rejection after the limit.
- [ ] **Step 2: Write failing tests for request-scoped concurrency.** Run concurrent append/accept and concurrent accept/reject against a real PostgreSQL database; assert one winner, no late message, no duplicate activities, and no duplicate outbox work.
- [ ] **Step 3: Write failing tests for offline discovery and deep links.** Assert `REQUEST_MESSAGE_RECEIVED` activity/unread behavior and that realtime/push payloads include requestId.
- [ ] **Step 4: Write failing tests for replay ordering and retry.** Assert deterministic `(createdAt,id)` ordering, historical messages use `notOfflinePush: true`, partial progress resumes at the next message, and the accepted reply is sent once.
- [ ] **Step 5: Run the focused friend/notification tests and verify each new test fails for the current implementation.**
- [ ] **Step 6: Implement the hard total cap and one advisory-lock helper keyed by request ID.** Enforce the 50-message total limit and existing sender-before-reply cap inside the transaction; re-read request state for append, accept, reject, and cancel; use 409 `FRIEND_REQUEST_NOT_PENDING` for append-after-transition and 409 `FRIEND_REQUEST_ALREADY_HANDLED` for losing decisions.
- [ ] **Step 7: Implement the durable message activity and request relation.** Upsert the recipient’s latest message activity, reset unread state, preserve the existing friend activity contract, and expose requestId in DTO/push data.
- [ ] **Step 8: Extend the friend outbox with stable dedupe keys and `FINALIZE_ACCEPTED_CHAT` progress.** Remove the fire-and-forget replay path; process imports, replay cursor, and accepted reply in order, retrying transient OpenIM errors.
- [ ] **Step 9: Add deterministic OpenIM message IDs and disable offline push for replayed historical messages.** Add the explicit self-sync option to conversation clearing, and write friend-deletion plus conversation-clearing outbox rows in the same database transaction as the friendship deletion.
- [ ] **Step 10: Add the `CHAT_ONLY` authorization contract to the trace service.** Cover feed filtering, new-count filtering, direct detail not-found behavior, like/comment denial, asymmetric grants, and pending-grant promotion on accept with real-DB tests.
- [ ] **Step 11: Run focused tests and all existing friend/notification/OpenIM/trace suites.**
- [ ] **Step 12: Commit with `git add` and `git commit -m "fix(friend): make request threads atomic and durable"`.**

## Task 3: Make notification, Expo, profile, and image-comment delivery reliable

**Files:**
- Modify: `prisma/schema.prisma` and create push/profile outbox migrations
- Modify: `src/notification/notification.service.ts`, `src/notification/notification-push.service.ts`, notification DTO/controller/constants
- Modify: push/profile outbox processors and tests
- Modify: `src/user/user.service.ts` and user DTO tests
- Modify: `src/trace/trace.service.ts`, trace DTOs, notification mapping/tests

- [ ] **Step 1: Write failing tests for token safety.** Cover Expo token shape, 10-token eviction, token transfer to another user, cancellation of old-owner unsent deliveries, and new-token exclusion from eviction.
- [ ] **Step 2: Write failing tests for project grouping and delivery recovery.** Cover multi-project batching, 429/5xx retry, ticket persistence, receipt polling, DeviceNotRegistered disabling, and terminal errors.
- [ ] **Step 3: Write failing tests for profile and notification correctness.** Cover normalized nickname sync, in-flight profile supersession, invalid page rejection, legacy friend-notification visibility, requestId deep links, and PROFILE_LIKE body.
- [ ] **Step 4: Write failing tests for image comments.** Cover `images: ['']` rejection, pure-image notification summary, and push body that does not reuse trace text.
- [ ] **Step 5: Run the focused notification/user/trace tests and verify expected failures.**
- [ ] **Step 6: Implement bounded token registration and project-aware selection.** Transfer ownership atomically; before transfer, cancel old-owner PENDING/RETRY deliveries for that token; delete the oldest active tokens beyond 10 while explicitly excluding the newly registered token; and snapshot token/user/project in delivery rows.
- [ ] **Step 7: Implement the Prisma-backed push delivery outbox in the same transaction as notification creation.** Enforce a unique dedupe key on `(notificationId, deviceTokenIdentity)`, use a nullable token FK with `onDelete: SetNull`, and add attempt/backoff state, ticket IDs, receipt polling, immutable payload snapshots, and terminal token disabling; do not log token values or message contents.
- [ ] **Step 8: Implement the versioned profile-sync outbox.** Send normalized persisted values, compare version before/after OpenIM calls, and retry the newest payload when superseded.
- [ ] **Step 9: Add validated notification pagination, requestId fields, compatibility friend types, and PROFILE_LIKE fallback.**
- [ ] **Step 10: Normalize image arrays and build an image-aware comment notification summary.** Reject blank entries before storage and notification creation.
- [ ] **Step 11: Run focused tests and all notification/user/trace suites.**
- [ ] **Step 12: Commit with `git add` and `git commit -m "fix(notification): make external delivery durable"`.**

## Task 4: Harden operational tooling and quality gates

**Files:**
- Modify: `scripts/set-vip.mjs`; create a testable argument helper if needed
- Create: script unit tests under `scripts/__tests__/`
- Modify: files reported by CI ESLint/Prettier
- Modify: any migration/fixture formatting touched by prior tasks

- [ ] **Step 1: Write failing tests for missing DATABASE_URL, invalid VIP values, `--id`, duplicate nicknames, and valid 0–5 levels.**
- [ ] **Step 2: Run the script tests and verify they fail because of the hard-coded fallback and unsupported ID hint.**
- [ ] **Step 3: Implement fail-closed environment handling, explicit `--id`/`--nickname` parsing, safe-integer 0–5 validation, and deterministic usage errors.**
- [ ] **Step 4: Run `npx eslint "{src,apps,libs,test}/**/*.ts"` and `npx prettier --check "src/**/*.ts" "test/**/*.ts" "scripts/**/*.{mjs,js,ts}" "prisma/**/*.prisma"`; run `git diff --check` for SQL migrations, then fix all branch-introduced errors without using `--fix` in CI.**
- [ ] **Step 5: Run script tests and the full unit suite.**
- [ ] **Step 6: Commit with `git add` and `git commit -m "fix(ops): harden vip tooling and CI quality"`.**

## Task 5: Full verification and release handoff

- [ ] **Step 1: Run `npx tsc -p tsconfig.build.json --noEmit`.** Expected: exit 0.
- [ ] **Step 2: Run `npm run build`.** Expected: exit 0.
- [ ] **Step 3: Run `npm test -- --runInBand` and `npm run test:cov`.** Expected: zero failures and coverage thresholds satisfied.
- [ ] **Step 3a: Run `npx eslint "{src,apps,libs,test}/**/*.ts"`, `npx prettier --check "src/**/*.ts" "test/**/*.ts" "scripts/**/*.{mjs,js,ts}" "prisma/**/*.prisma"`, and `git diff --check`.** Expected: zero errors and no formatting drift.
- [ ] **Step 4: Start a clean PostgreSQL 16 instance and run `npx prisma migrate deploy`.** Expected: every migration applies from empty.
- [ ] **Step 5: Run `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`.** Expected: no difference detected.
- [ ] **Step 6: Run `npm run test:e2e` against the clean database.** Expected: all suites pass.
- [ ] **Step 7: Run `git diff --check`, `git status --short --branch`, and inspect the final commit list.** Expected: no unintended files, no whitespace errors, and only the isolated worktree contains the remediation commits.
- [ ] **Step 8: Perform a final production review against the 31-item traceability matrix and report any remaining non-code observation (such as historical commit size) separately from fixed bugs.**
