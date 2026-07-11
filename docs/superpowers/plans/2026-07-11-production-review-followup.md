# Production Review Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all production-review findings on `feat/friend-request-annotations` while preserving the all-joins-require-review product contract.

**Architecture:** Apply a forward-only compatibility migration, then make every outbox transition lease/version-aware. Serialize circle application state with one advisory-lock key and make reconciliation bounded without starvation. Preserve existing service boundaries while making Expo ticket outcomes and friend-request deep links explicit.

**Tech Stack:** NestJS 11, TypeScript 6, Prisma 7, PostgreSQL, Jest 30, Expo Push API, OpenIM.

## Global Constraints

- Existing migrations are potentially applied and must not be edited or removed.
- `Circle.isPublic` is a physical rolling-deploy compatibility field only; it must not return to DTOs or business decisions.
- Every production change begins with a focused regression test that fails for the reviewed bug.
- Worker terminal writes must use compare-and-set semantics and may not update a row after losing its lease or generation.
- Changes stay limited to the eight reviewed findings and their direct tests.

---

### Task 1: Forward-Compatible Schema and Worker Metadata

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260711000000_production_review_followup/migration.sql`
- Test: `src/prisma/production-review-followup-migration.spec.ts`

**Interfaces:**
- Produces: `UserProfileSyncOutbox.generation: number`, `UserProfileSyncOutbox.leaseToken: string | null`
- Produces: `FriendChatReplayOutbox.leaseToken: string | null`
- Produces: `NotificationPushOutbox.leaseToken: string | null`
- Produces: `NotificationPushOutboxStatus.TERMINAL`
- Produces: `Circle.isPublic: boolean` as a database compatibility field only

- [ ] **Step 1: Write a failing migration/schema test**

Assert that the follow-up SQL contains forward-only `ADD COLUMN IF NOT EXISTS` statements for `Circle.isPublic`, profile generation/lease, replay lease, and push lease; adds the terminal push state; and that `schema.prisma` exposes the same contract.

```ts
expect(sql).toContain('ADD COLUMN IF NOT EXISTS "isPublic"');
expect(sql).toContain('ADD COLUMN IF NOT EXISTS "generation"');
expect(sql).toContain('ADD COLUMN IF NOT EXISTS "leaseToken"');
expect(sql).toContain("ADD VALUE IF NOT EXISTS 'TERMINAL'");
expect(schema).toContain('generation Int @default(0)');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx jest production-review-followup-migration --runInBand`

Expected: failure because the follow-up migration and schema fields do not exist.

- [ ] **Step 3: Add the forward-only migration and Prisma fields**

Use idempotent SQL equivalent to:

```sql
ALTER TABLE "Circle"
  ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserProfileSyncOutbox"
  ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;
ALTER TABLE "FriendChatReplayOutbox"
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;
ALTER TABLE "NotificationPushOutbox"
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;
ALTER TYPE "NotificationPushOutboxStatus"
  ADD VALUE IF NOT EXISTS 'TERMINAL';
```

Add matching nullable/defaulted fields to Prisma. Do not expose `isPublic` in circle DTOs or services.

- [ ] **Step 4: Generate and validate Prisma artifacts**

Run: `npx prisma generate`

Run: `npx prisma validate`

Expected: both commands exit 0.

- [ ] **Step 5: Run the migration test and verify GREEN**

Run: `npx jest production-review-followup-migration --runInBand`

Expected: focused migration assertions pass.

- [ ] **Step 6: Commit the schema unit**

```bash
git add prisma/schema.prisma prisma/migrations/20260711000000_production_review_followup src/prisma/production-review-followup-migration.spec.ts
git commit -m "fix(db): add forward-compatible worker leases"
```

### Task 2: Versioned Profile Synchronization

**Files:**
- Modify: `src/user/user.service.ts`
- Modify: `src/user/user-profile-sync-outbox.processor.ts`
- Modify: `src/user/__tests__/user.update-normalization.spec.ts`
- Create or modify: `src/user/user-profile-sync-outbox.processor.spec.ts`

**Interfaces:**
- Consumes: profile `generation` and `leaseToken` from Task 1
- Produces: generation-aware enqueue and lease-protected completion/failure

- [ ] **Step 1: Write failing supersession tests**

Cover an update that increments generation and clears the old lease, plus a worker whose generation-1 completion occurs after generation 2 is enqueued.

```ts
expect(prisma.userProfileSyncOutbox.upsert).toHaveBeenCalledWith(
  expect.objectContaining({
    update: expect.objectContaining({
      generation: { increment: 1 },
      leaseToken: null,
    }),
  }),
);
expect(prisma.userProfileSyncOutbox.updateMany).toHaveBeenCalledWith(
  expect.objectContaining({
    where: expect.objectContaining({ generation: 1, leaseToken }),
  }),
);
```

- [ ] **Step 2: Run profile tests and verify RED**

Run: `npx jest user.update-normalization user-profile-sync-outbox --runInBand`

Expected: failures show missing generation/lease predicates.

- [ ] **Step 3: Implement generation-aware enqueue**

On create use generation `1`; on update increment generation, reset status and retry metadata, and clear `leaseToken`. Keep the enqueue in the same transaction as the user update.

- [ ] **Step 4: Implement lease-protected processing**

Generate a UUID lease for each claim. Claim the observed generation with `updateMany`, fetch the latest user only after the claim, and use `updateMany` with `{ id, generation, leaseToken, status: 'PROCESSING' }` for completion and failure. A zero-count terminal update means the work was superseded and must be ignored.

- [ ] **Step 5: Run profile tests and verify GREEN**

Run: `npx jest user.update-normalization user-profile-sync-outbox --runInBand`

Expected: all profile synchronization tests pass.

- [ ] **Step 6: Commit the profile unit**

```bash
git add src/user/user.service.ts src/user/user-profile-sync-outbox.processor.ts src/user/__tests__/user.update-normalization.spec.ts src/user/user-profile-sync-outbox.processor.spec.ts
git commit -m "fix(user): protect profile sync supersession"
```

### Task 3: Lease-Protected Chat Replay and Push Claims

**Files:**
- Modify: `src/friend/friend-chat-replay-outbox.processor.ts`
- Modify: `src/friend/friend-chat-replay-outbox.processor.spec.ts`
- Modify: `src/notification/notification-push-outbox.processor.ts`
- Create or modify: `src/notification/notification-push-outbox.processor.spec.ts`

**Interfaces:**
- Consumes: replay and push `leaseToken` fields from Task 1
- Produces: `updateMany` compare-and-set claims, progress writes, and terminal writes

- [ ] **Step 1: Write failing competing-worker tests**

For replay, simulate two stale workers where only the first observed `lockedAt` claim succeeds. Assert that progress and terminal writes include the lease token. For push, advance time during a batch and assert each claim receives a fresh `lockedAt`; simulate a lost lease and assert no terminal overwrite occurs.

- [ ] **Step 2: Run worker tests and verify RED**

Run: `npx jest friend-chat-replay-outbox notification-push-outbox --runInBand`

Expected: stale replay can currently be double-claimed and push uses the batch timestamp.

- [ ] **Step 3: Implement replay lease ownership**

Generate a UUID at claim time. Match pending/failed status and, for stale processing, the observed `lockedAt`. Store the lease and require it in `persistProgress`, completion, and failure `updateMany` calls. Stop processing after any zero-count progress write.

- [ ] **Step 4: Implement fresh push claims and terminal CAS**

Compute `claimNow` inside the loop, derive stale cutoff from it, store a fresh UUID lease, and require `{ id, leaseToken, status: 'PROCESSING' }` when marking completed or failed.

- [ ] **Step 5: Run worker tests and verify GREEN**

Run: `npx jest friend-chat-replay-outbox notification-push-outbox --runInBand`

Expected: all lease and stale-worker cases pass.

- [ ] **Step 6: Commit the worker unit**

```bash
git add src/friend/friend-chat-replay-outbox.processor.ts src/friend/friend-chat-replay-outbox.processor.spec.ts src/notification/notification-push-outbox.processor.ts src/notification/notification-push-outbox.processor.spec.ts
git commit -m "fix(outbox): enforce worker lease ownership"
```

### Task 4: Circle Reconciliation and Application Locking

**Files:**
- Create: `src/circle-invitation/circle-application-lock.ts`
- Modify: `src/circle/circle.service.ts`
- Modify: `src/circle/circle.service.spec.ts`
- Modify: `src/circle-invitation/circle-invitation.service.ts`
- Modify: `src/circle-invitation/circle-invitation.service.spec.ts`

**Interfaces:**
- Produces: `circleApplicationLockKey(circleId: string, applicantId: string): string`
- Consumes: the same lock key in join, leave, verifier response, admin approval, reconciliation, and invitation creation

- [ ] **Step 1: Write failing reconciliation tests**

Test that the candidate query only returns threshold-eligible IDs, that 100 older ineligible rows cannot hide an eligible row, and that an exception for candidate A still allows candidate B to finalize.

- [ ] **Step 2: Write a failing leave/approve race regression**

Mock the pre-transaction membership as `PENDING` and the locked in-transaction membership as `ACTIVE`. Assert `leaveCircle` decrements `memberCount`, proving it derives behavior from current transactional state.

- [ ] **Step 3: Run circle tests and verify RED**

Run: `npx jest circle.service circle-invitation.service --runInBand`

Expected: current reconciliation scans arbitrary pending rows and leave uses its stale outer read.

- [ ] **Step 4: Add the shared lock key and transactional re-read**

Use one exact key:

```ts
export const circleApplicationLockKey = (
  circleId: string,
  applicantId: string,
) => `circle-invite:${circleId}:${applicantId}`;
```

Acquire it inside all application state transitions. In `leaveCircle`, re-read membership after the lock and use that row for deletion and count adjustment.

- [ ] **Step 5: Make reconciliation eligible-only and failure-isolated**

Select at most 100 IDs using a parameterless Prisma `$queryRaw` query with
`status = 'PENDING' AND approvedCount >= requiredCount`, ordered by
`updatedAt, id`. Process each ID inside its own `try/catch`; preserve transaction rollback on admission failure and continue to later candidates.

- [ ] **Step 6: Run circle tests and verify GREEN**

Run: `npx jest circle.service circle-invitation.service --runInBand`

Expected: reconciliation, isolation, and current-state leave tests pass.

- [ ] **Step 7: Commit the circle consistency unit**

```bash
git add src/circle-invitation/circle-application-lock.ts src/circle/circle.service.ts src/circle/circle.service.spec.ts src/circle-invitation/circle-invitation.service.ts src/circle-invitation/circle-invitation.service.spec.ts
git commit -m "fix(circle): serialize application lifecycle"
```

### Task 5: Cancelled Verification Visibility

**Files:**
- Modify: `src/circle-invitation/circle-invitation.service.ts`
- Modify: `src/circle-invitation/circle-invitation.service.spec.ts`
- Modify: `src/circle/circle.service.spec.ts`

**Interfaces:**
- Produces: pending-verification queries constrained by parent invitation status

- [ ] **Step 1: Write a failing cancelled-task test**

Assert that `getMyPendingVerifications` filters with both verifier status
`PENDING` and parent invitation status `PENDING`. Preserve the existing test
that responding to a cancelled invitation fails closed.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx jest circle-invitation.service --runInBand`

Expected: query currently omits the parent invitation status.

- [ ] **Step 3: Add the parent-status filter**

Use the Prisma relation filter equivalent to:

```ts
where: {
  verifiers: { some: { verifierID: userId, status: 'PENDING' } },
  status: 'PENDING',
}
```

Apply the same parent-state rule to every endpoint that advertises pending verifier work.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx jest circle-invitation.service --runInBand`

Expected: cancelled invitations no longer appear.

- [ ] **Step 5: Commit the verifier visibility unit**

```bash
git add src/circle-invitation/circle-invitation.service.ts src/circle-invitation/circle-invitation.service.spec.ts src/circle/circle.service.spec.ts
git commit -m "fix(circle): hide cancelled verifier work"
```

### Task 6: Expo Ticket Outcomes

**Files:**
- Modify: `src/notification/notification-push.service.ts`
- Modify: `src/notification/notification-push.service.spec.ts`
- Modify: `src/notification/notification-push-outbox.processor.ts`
- Modify: `src/notification/notification-push-outbox.processor.spec.ts`

**Interfaces:**
- Produces: `PushDeliveryResult` with `DELIVERED`, `RETRYABLE_FAILURE`, or `TERMINAL_FAILURE`
- Consumes: result in the outbox processor to retry or record terminal outcomes

- [ ] **Step 1: Write failing ticket tests**

Cover HTTP 200 with `MessageRateExceeded`, `DeviceNotRegistered`, a terminal payload error, and a mixed batch. Assert retryable errors do not return delivered and terminal errors are explicitly surfaced.

- [ ] **Step 2: Run push tests and verify RED**

Run: `npx jest notification-push.service notification-push-outbox --runInBand`

Expected: current implementation returns success for every HTTP-200 ticket set.

- [ ] **Step 3: Implement explicit result classification**

Return a structured result:

```ts
type PushDeliveryResult = {
  status: 'DELIVERED' | 'RETRYABLE_FAILURE' | 'TERMINAL_FAILURE';
  error?: string;
};
```

Disable `DeviceNotRegistered` tokens. Classify rate/temporary/unknown errors as retryable and known invalid payload/credential errors as terminal. Never log token values or notification contents.

- [ ] **Step 4: Consume results in the outbox processor**

Mark delivered jobs `COMPLETED`, retry retryable failures with the existing backoff, and mark non-retryable ticket failures `TERMINAL` with a bounded `lastError`. Reuse the lease CAS from Task 3 for every terminal write.

- [ ] **Step 5: Run push tests and verify GREEN**

Run: `npx jest notification-push.service notification-push-outbox --runInBand`

Expected: ticket-level and mixed-batch tests pass.

- [ ] **Step 6: Commit the Expo unit**

```bash
git add src/notification/notification-push.service.ts src/notification/notification-push.service.spec.ts src/notification/notification-push-outbox.processor.ts src/notification/notification-push-outbox.processor.spec.ts
git commit -m "fix(notification): handle Expo ticket failures"
```

### Task 7: Friend Lifecycle Deep Links

**Files:**
- Modify: `src/friend/friend.service.ts`
- Modify: `src/friend/friend.service.spec.ts`
- Modify: `src/notification/notification.service.spec.ts`

**Interfaces:**
- Consumes: existing optional `requestId` notification parameter
- Produces: `requestId` for received, accepted, rejected, and message notifications

- [ ] **Step 1: Write failing lifecycle notification tests**

Assert that `sendRequest` passes the created request ID and `handleRequest`
passes its request ID to `createFriendRequestNotification` for both accepted
and rejected decisions.

- [ ] **Step 2: Run friend tests and verify RED**

Run: `npx jest friend.service notification.service --runInBand`

Expected: received/accepted/rejected calls omit `requestId`.

- [ ] **Step 3: Pass canonical request IDs**

Add `requestId: request.id` to the received notification and
`requestId: nextRequest.id` to accepted/rejected notifications. Keep message
notifications unchanged because they already pass the ID.

- [ ] **Step 4: Run friend tests and verify GREEN**

Run: `npx jest friend.service notification.service --runInBand`

Expected: all lifecycle types map to `fromFriendRequestID` and realtime DTO `requestId`.

- [ ] **Step 5: Commit the deep-link unit**

```bash
git add src/friend/friend.service.ts src/friend/friend.service.spec.ts src/notification/notification.service.spec.ts
git commit -m "fix(friend): include request ids in lifecycle notifications"
```

### Task 8: Full Verification and Final Review

**Files:**
- Review all files changed by Tasks 1-7

**Interfaces:**
- Consumes: all preceding task outputs
- Produces: release evidence and a clean branch

- [ ] **Step 1: Run focused suites together**

Run: `npx jest circle.service circle-invitation.service friend.service friend-chat-replay-outbox notification.service notification-push.service notification-push-outbox user.update-normalization user-profile-sync-outbox production-review-followup-migration --runInBand`

Expected: zero failed suites and zero failed tests.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test -- --runInBand`

Expected: zero failures.

- [ ] **Step 3: Run compiler and build checks**

Run: `npx tsc -p tsconfig.build.json --noEmit`

Run: `npm run build`

Expected: both exit 0.

- [ ] **Step 4: Run Prisma and migration checks**

Run: `npx prisma validate`

Run: `bash scripts/verify-migration-baseline.sh` against the disposable PostgreSQL verification database used by CI.

Expected: schema is valid and migration history aligns with the final schema.

- [ ] **Step 5: Run static repository checks**

Run: `git diff --check origin/feat/friend-request-annotations...HEAD`

Run: `git status --short --branch`

Expected: no whitespace errors; only intentional commits ahead of the remote branch.

- [ ] **Step 6: Request an independent production code review**

Review the complete range `4177e27..HEAD`, verify every finding has a direct regression test, and fix all Critical/Important findings before handoff.
