# Plaza Notify/Report Production Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plaza publication notifications durable and bounded, and close the report/share authorization defects found in production review.

**Architecture:** Rebase onto current `origin/main`, then use its transactional `NotificationPushOutbox`. Resolve eligible publication recipients deterministically, create the post, notifications, and push jobs in one transaction, and emit realtime events only after commit. Reuse plaza visibility predicates for reports and select only non-deleted linked circles for join guidance.

**Tech Stack:** NestJS 11, TypeScript, Prisma 7/PostgreSQL, Jest 30.

## Global Constraints

- Keep the existing 500-recipient publication fan-out cap.
- Preserve existing HTTP response DTOs and stable error codes.
- Do not perform token lookup or Expo HTTP delivery in the post request.
- Do not build a post-report moderation workflow in this change.
- Every behavior change follows red-green-refactor TDD.

---

### Task 1: Integrate the current durable-outbox baseline

**Files:**
- Rebase: `feat/plaza-notify-report` onto `origin/main`
- Verify: `src/notification/notification.service.ts`
- Verify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: `NotificationPushOutbox` and `NotificationService.createNotification()` from current main.
- Produces: a conflict-free branch where all later tests exercise the actual merge target.

- [ ] **Step 1: Rebase the feature branch**

Run: `git rebase origin/main`

Resolve overlaps by keeping the feature's two new notification types and report model while retaining main's push-outbox implementation and friend-request notification relations.

- [ ] **Step 2: Regenerate Prisma and verify the baseline builds**

Run: `npm run prisma:generate && npm run build`

Expected: both commands exit 0; `sendPushBestEffort` is absent from the rebased notification service.

- [ ] **Step 3: Run the existing targeted tests**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts src/notification/notification.service.spec.ts src/filters/all-exception.filter.spec.ts`

Expected: any failures are only merge-adaptation failures and are recorded before behavior changes.

### Task 2: Create publication notifications and push jobs atomically

**Files:**
- Modify: `src/notification/notification.service.spec.ts`
- Modify: `src/notification/notification.service.ts`
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`

**Interfaces:**
- Consumes: `Prisma.TransactionClient`, `NOTIFICATION_REALTIME_INCLUDE`, and `NotificationPushOutbox`.
- Produces: `createCirclePostPublishedNotifications(tx, params): Promise<Array<{toUserId: string; notification: NotificationRealtimeDto}>>`.

- [ ] **Step 1: Write failing notification-service tests**

Add tests proving the method uses the supplied transaction, calls
`tx.notification.createManyAndReturn()` with publication notification data,
calls `tx.notificationPushOutbox.createMany()` with the returned notification
IDs, reloads rows through `tx.notification.findMany()`, and never calls
`NotificationPushService.sendNotification()`.

Use this transaction shape in the test:

```ts
const tx = {
  notification: {
    createManyAndReturn: jest.fn().mockResolvedValue([
      { id: 'n2', toUserID: 'member-2' },
      { id: 'n3', toUserID: 'member-3' },
    ]),
    findMany: jest.fn().mockResolvedValue([row2, row3]),
  },
  notificationPushOutbox: {
    createMany: jest.fn().mockResolvedValue({ count: 2 }),
  },
} as unknown as Prisma.TransactionClient;
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `npm test -- --runInBand src/notification/notification.service.spec.ts`

Expected: FAIL because the current method neither accepts a transaction nor creates outbox rows.

- [ ] **Step 3: Implement the transaction-scoped bulk method**

Implement the following flow without direct push calls:

```ts
const created = await tx.notification.createManyAndReturn({
  data: recipients.map((toUserID) => ({
    toUserID,
    fromUserID: params.fromUserId,
    type: NotificationType.CIRCLE_POST_PUBLISHED,
    fromCirclePostID: params.postId,
    content: '',
  })),
  select: { id: true, toUserID: true },
});
await tx.notificationPushOutbox.createMany({
  data: created.map(({ id }) => ({ notificationID: id })),
});
```

Reload only `created.map(({id}) => id)` with `NOTIFICATION_REALTIME_INCLUDE`, map the rows, and filter nullable `toUserID` safely.

- [ ] **Step 4: Write a failing circle-plaza transaction test**

Assert that `createPost()` invokes the notification bulk method with the same
transaction object used for `circlePost.create`, and that realtime broadcasts
occur after the transaction promise resolves. Make the outbox method reject and
assert `createPost()` rejects rather than returning a committed post.

- [ ] **Step 5: Run the plaza test and verify RED**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts`

Expected: FAIL because publication notification creation is currently fire-and-forget after the post transaction.

- [ ] **Step 6: Move publication notification creation into the post transaction**

Return `{ post, publishedNotifications }` from the transaction. After commit,
iterate `publishedNotifications` and call
`realtime.broadcastNotificationCreated()` in a guarded best-effort loop.

- [ ] **Step 7: Run both suites and verify GREEN**

Run: `npm test -- --runInBand src/notification/notification.service.spec.ts src/circle-plaza/circle-plaza.service.spec.ts`

Expected: PASS.

### Task 3: Make recipient filtering deterministic and cap-aware

**Files:**
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`

**Interfaces:**
- Consumes: post target circle IDs, author ID, and Prisma user/block relations.
- Produces: at most 500 sorted eligible recipient IDs before the post transaction.

- [ ] **Step 1: Write failing eligibility tests**

Assert the recipient query contains:

```ts
where: {
  circleID: { in: ['circle-1'] },
  status: 'ACTIVE',
  userID: { not: 'author-1' },
  user: {
    blocksIssued: { none: { blockedID: 'author-1' } },
    blocksReceived: { none: { blockerID: 'author-1' } },
  },
},
distinct: ['userID'],
orderBy: { userID: 'asc' },
take: 501,
```

Add a 501-member result test that expects only the first 500 IDs and a warning containing `eligible>500`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts`

Expected: FAIL because block filtering currently happens after `take` and no stable order is specified.

- [ ] **Step 3: Implement query-level filtering and deterministic truncation**

Remove the second `block.findMany()` query. Determine `capped` from
`members.length > CIRCLE_POST_PUBLISH_FANOUT_CAP`, log
`eligible>${CIRCLE_POST_PUBLISH_FANOUT_CAP}`, and slice to 500.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts`

Expected: PASS.

### Task 4: Enforce report visibility

**Files:**
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`

**Interfaces:**
- Consumes: `activeUnexpiredPostWhere()` and `memberCircleScope(userId)`.
- Produces: report lookup that returns not found for every invisible state.

- [ ] **Step 1: Write failing report-authorization tests**

Assert `circlePost.findFirst()` receives:

```ts
where: {
  ...activePostPredicate,
  id: 'post-1',
  circleLinks: {
    some: { circle: memberCircleScope('reporter-2') },
  },
},
```

Add cases where the lookup returns null for a non-member and an expired/deleted
post; both must throw `NotFoundException` and must not call report upsert.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts`

Expected: FAIL because the current lookup uses only the post ID.

- [ ] **Step 3: Reuse the plaza visibility predicates in `reportPost()`**

Change only the lookup predicate; keep self-report rejection, reason trimming,
and the idempotent upsert unchanged.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts`

Expected: PASS.

### Task 5: Return only a joinable circle for non-member shares

**Files:**
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`

**Interfaces:**
- Consumes: the post's legacy primary circle and filtered `circleLinks`.
- Produces: `PLAZA_NOT_CIRCLE_MEMBER` details for a non-deleted circle, otherwise `PLAZA_POST_NOT_FOUND`.

- [ ] **Step 1: Write failing share-fallback tests**

Add one test where `circle.deleted` is true and a filtered link contains
`circle-2`; expect details for `circle-2`. Add one test with no valid link and
expect `NotFoundException`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts`

Expected: FAIL because the fallback always returns the primary circle.

- [ ] **Step 3: Select the primary circle only when active**

Query only posts having `circleLinks.some.circle.deleted = false`, select the
primary circle's `deleted` flag plus one non-deleted linked circle, and compute:

```ts
const joinCircle = visible.circle.deleted
  ? visible.circleLinks[0]?.circle
  : visible.circle;
```

Return not found when `joinCircle` is absent.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts`

Expected: PASS.

### Task 6: Final verification and delivery

**Files:**
- Verify all modified files
- Update: this plan's checkboxes as work completes

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: a production-ready branch with evidence.

- [ ] **Step 1: Format changed TypeScript files**

Run: `npx prettier --write src/circle-plaza/circle-plaza.service.ts src/circle-plaza/circle-plaza.service.spec.ts src/notification/notification.service.ts src/notification/notification.service.spec.ts`

- [ ] **Step 2: Regenerate and build**

Run: `npm run prisma:generate && npm run build`

Expected: exit 0.

- [ ] **Step 3: Run targeted tests**

Run: `npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts src/notification/notification.service.spec.ts src/filters/all-exception.filter.spec.ts`

Expected: all pass.

- [ ] **Step 4: Run the full suite**

Run: `npm test -- --runInBand`

Expected: all tests pass, or unrelated baseline failures are identified by exact suite and assertion.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check && git status --short && git diff origin/main...HEAD --stat`

Expected: no whitespace errors and only scoped changes.

### Task 7: Make Redis deployment verification cross-platform

**Files:**
- Modify: `src/config/redis-deploy.spec.ts`

**Interfaces:**
- Consumes: a functional Bash executable and repository text files.
- Produces: script tests that execute under Git Bash on Windows and PATH Bash elsewhere, plus CRLF-safe compose assertions.

- [ ] **Step 1: Preserve the failing baseline**

Run: `npm test -- --runInBand src/config/redis-deploy.spec.ts`

Expected: three failures: two WSL-launch failures and one LF-only compose match failure.

- [ ] **Step 2: Add a functional Bash resolver**

Use `spawnSync(candidate, ['-c', 'true'])` to validate candidates. On Windows,
try `C:\\Program Files\\Git\\bin\\bash.exe` and
`C:\\Program Files\\Git\\usr\\bin\\bash.exe` before `bash`; elsewhere use
`bash`. Throw during suite setup if none works so script tests never become
false positives.

- [ ] **Step 3: Use the resolved executable for every script assertion**

Replace every `execFileSync('bash', ...)` call with
`execFileSync(bashExecutable, ...)`.

- [ ] **Step 4: Make compose matching line-ending independent**

Use `/\r?\n  redis:\r?\n([\s\S]*?)\r?\n  minio:/`.

- [ ] **Step 5: Verify the focused and full suites**

Run: `npm test -- --runInBand src/config/redis-deploy.spec.ts`

Expected: 4/4 pass.

Run: `npm test -- --runInBand`

Expected: all non-integration Jest tests pass, with only explicitly skipped integration suites.

