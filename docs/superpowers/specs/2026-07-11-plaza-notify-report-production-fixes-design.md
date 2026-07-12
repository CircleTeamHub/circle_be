# Plaza Notify/Report Production Fixes Design

## Context

`feat/plaza-notify-report` adds circle-post publication notifications,
collaboration-recognition notifications, post reports, and a non-member share
response. Production review found six issues:

1. the branch still calls the direct-push helper removed by current `main`;
2. a large-circle publish can start roughly 500 token queries and HTTP pushes;
3. post creation, notification insertion, and push scheduling are not atomic;
4. users can report posts they cannot view, including inactive posts;
5. the non-member response can point at a deleted primary circle; and
6. fan-out truncation is evaluated after block filtering, making it incomplete
   and sometimes silent.

The branch will first be rebased onto current `origin/main`, whose durable
`NotificationPushOutbox` is the required push-delivery mechanism.

## Goals

- Keep creation of a post, its publication notifications, and their push-outbox
  jobs transactionally consistent.
- Never perform per-recipient token lookup or Expo HTTP delivery in the post
  request.
- Cap publication fan-out deterministically at 500 eligible recipients and log
  whenever more eligible recipients exist.
- Permit reports only for active, unexpired posts visible to the reporter as an
  active member of at least one linked, non-deleted circle.
- Return a joinable, non-deleted linked circle in the non-member share error.
- Preserve existing API response shapes and notification DTOs.

## Non-goals

- Building a post-report moderation queue or changing report-review policy.
- Replacing realtime delivery with a durable websocket outbox.
- Removing the 500-recipient product safety cap.
- Refactoring unrelated notification or circle-plaza behavior.

## Architecture

### Atomic publication notification creation

Before opening the post transaction, `CirclePlazaService` resolves eligible
recipient IDs using a single `CircleMember` query:

- membership status must be `ACTIVE`;
- the member belongs to any target circle;
- the author is excluded;
- users blocked in either direction with the author are excluded in the query;
- results are distinct and ordered by `userID` for deterministic selection; and
- the query takes 501 rows. A 501st row means the 500 cap was reached, so the
  service logs `eligible>500` and keeps the first 500.

The post transaction then:

1. creates the post and circle links;
2. increments circle post counters;
3. bulk-creates one `CIRCLE_POST_PUBLISHED` notification per recipient and
   returns their IDs;
4. bulk-creates one `NotificationPushOutbox` row per notification; and
5. reloads notification rows with the existing realtime include.

All five steps commit or roll back together. After commit, the service emits
best-effort `notification.created` websocket events from the returned DTOs.
There is no direct call to `NotificationPushService`; the existing outbox
processor owns token lookup, retry, rate control, and Expo delivery.

`NotificationService` exposes a transaction-scoped bulk method so notification
and outbox invariants stay inside the notification module while the caller owns
the larger post transaction.

### Report authorization

`reportPost` looks up the target with the same active/unexpired predicate used
by the feed and detail API, plus a linked-circle scope requiring that the
reporter is an ACTIVE member and that the circle is not deleted. Inaccessible,
deleted, expired, and missing posts all return `PLAZA_POST_NOT_FOUND` to avoid
revealing private-post existence. A visible author still receives
`PLAZA_REPORT_SELF`.

The existing idempotent `(postID, reporterID)` upsert and reason normalization
remain unchanged.

### Joinable-circle selection

When the normal detail query misses, the existence query still requires an
active, unexpired post with at least one non-deleted linked circle. It loads the
legacy primary circle and one valid linked circle. If the primary circle is not
deleted, it remains the preferred response for compatibility; otherwise the
service returns the valid linked circle. If no valid linked circle exists, the
request returns `PLAZA_POST_NOT_FOUND` instead of a join action.

## Error Handling

- Any notification or outbox database error aborts the post transaction and
  returns the normal request error; no partially created post is left behind.
- Realtime broadcast failures remain best-effort after commit and are logged;
  durable push delivery is unaffected.
- Report authorization deliberately uses 404 for all invisible states.
- Fan-out capping is not an error; it is deterministic and emits a warning.

## Testing

Tests are written before implementation and must demonstrate these failures:

- publication notifications and push-outbox rows use the caller transaction;
- no direct push service call occurs;
- failure to create outbox rows rolls back the enclosing post operation;
- blocked users are excluded before the 501-row cap;
- a 501st eligible member triggers deterministic truncation and a warning;
- non-members and inactive-post viewers cannot report;
- active members can still report and duplicate reports remain idempotent;
- a deleted primary circle falls back to an active linked circle; and
- a post with no active linked circle returns not found.

Verification consists of Prisma generation, targeted plaza/notification/filter
tests, production build, and the full Jest suite. Any unrelated baseline failure
will be reported separately with its test name and evidence.

## Cross-platform deployment-test harness

The full-suite failure is caused by the test harness, not the Redis deployment
configuration: Windows resolves `bash` to the WSL launcher even when no distro
is installed, and the compose parser assumes LF-only line endings. The test
suite will resolve a shell by executing a no-op and, on Windows, prefer the
standard Git Bash locations before falling back to PATH. All script tests use
that verified executable, so the negative-path assertion cannot pass merely
because Bash failed to start. Static compose matching accepts both LF and CRLF.

This change is test-only: `deploy/gen-env.sh` and production compose behavior
remain unchanged.

