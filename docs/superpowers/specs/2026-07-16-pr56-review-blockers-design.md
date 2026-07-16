# PR 56 Review Blockers Design

## Goal

Close the two production blockers found in PR #56 without breaking existing
clients:

1. Keep `Circle.memberCount` at or below `Circle.maxMembers` when different
   users are admitted to the same circle concurrently.
2. Allow callers to traverse every pending invitation while preserving the
   existing `InvitationDto[]` response shape.

## Context

`GroupService.inviteGroupMembers` currently takes advisory locks for each
`(circle, user)` pair. Those locks correctly serialize two operations for the
same applicant, but different applicants use disjoint locks. Under PostgreSQL's
default `READ COMMITTED` isolation, two transactions can therefore read the
same final available seat and both commit.

`CircleInvitationService.admitApplicant` is the other path that activates a
circle member and increments `memberCount`. Capacity correctness requires both
paths to use the same atomic rule. Creating a circle is not part of this race:
the owner and initial count are created in one transaction. `joinCircle`
creates a `PENDING` membership and does not consume a seat.

The three pending-list methods currently apply `take: 50` without accepting a
cursor. Invitations older than the first 50 cannot be reached.

## Capacity Approaches Considered

1. Take an explicit row or advisory lock for the circle before reading
   capacity. This is correct when every admission path follows the convention,
   but it lengthens the explicit critical section and makes correctness depend
   on a separate pre-lock step.
2. Run every admission transaction at `SERIALIZABLE` and retry serialization
   failures. This is correct, but it broadens retry behavior and can redo more
   work than the single capacity decision requires.
3. Perform one conditional atomic counter update after determining the number
   of membership rows actually activated. This is selected. PostgreSQL
   serializes concurrent updates to the same circle row internally, while
   different circles remain independent. A failed condition rolls back all
   membership and invitation changes in the surrounding transaction.

## Atomic Capacity Reservation

Add one shared database helper used by both direct group invitations and
invitation admission. Given a transaction client, circle ID, and positive seat
count, it executes the equivalent of:

```sql
UPDATE "Circle"
SET "memberCount" = "memberCount" + :seatCount,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = :circleId
  AND (
    "maxMembers" IS NULL
    OR "memberCount" + :seatCount <= "maxMembers"
  )
RETURNING "id";
```

The helper returns whether the row was updated. It does not expose a separate
lock API. A zero-seat call is a no-op; a negative seat count is rejected as a
programming error.

Each caller first performs its membership create/reactivation operations in
the existing transaction and derives `seatsTaken` from the affected-row
counts. If `seatsTaken` is positive, it calls the helper before writing the
OpenIM outbox or finalizing the invitation. If the conditional update returns
no row, the caller checks whether the circle still exists so it can preserve
the existing not-found error; an existing circle produces the existing
`CircleErrorCode.MemberLimit` response. Throwing either error rolls back the
membership writes.

The existing `(circle, user)` advisory locks remain responsible for
same-applicant idempotency and deadlock-safe batch ordering. They are not used
for capacity. The atomic Circle update is the single capacity serialization
point shared by `GroupService.inviteGroupMembers` and
`CircleInvitationService.admitApplicant`.

No schema migration is required. The design continues to treat `memberCount`
as the authoritative counter already used by the service; repairing historic
counter drift is outside this PR.

## Pagination Approaches Considered

1. Return `{ items, nextCursor }`. This gives explicit continuation metadata
   but breaks the existing array response contract.
2. Remove the result cap. This restores reachability but permits unbounded
   database and response work.
3. Keep `InvitationDto[]` and accept optional `cursor` and `limit` query
   parameters. This is selected because it is backward compatible and bounds
   every request.

## Pending Invitation Pagination

Add a query DTO with:

- `cursor?: UUID`, identifying the final invitation returned by the previous
  page.
- `limit?: integer`, defaulting to 50 and constrained to 1 through 100.

Apply it to:

- `GET /circle-invitation/pending`
- `GET /circle-invitation/my-applications`
- `GET /circle-invitation/circle/:circleId/pending`

All three methods keep returning `InvitationDto[]`. Clients request the next
page with the last item's `id`; a page shorter than `limit` is terminal. When a
page has exactly `limit` items, clients may make one final request that returns
an empty array.

Order every page by `createdAt DESC, id DESC`. Resolve the cursor's
`createdAt` and then apply a keyset boundary:

```text
createdAt < cursor.createdAt
OR (createdAt = cursor.createdAt AND id < cursor.id)
```

The normal endpoint predicate and authorization remain on the page query. The
cursor lookup is also scoped to the caller:

- verifier work requires a verifier relation for the requesting user;
- applicant work requires the same `applicantID`;
- circle work requires the same `circleID`, after the existing owner/admin
  check.

Cursor scope does not require the invitation or verifier relation to remain
`PENDING`. This lets traversal continue if the cursor item is resolved between
requests. A missing, malformed, or out-of-scope cursor returns a 400 invalid
cursor error and never changes the page filter or authorization scope.

## Error Handling and Compatibility

- Capacity exhaustion keeps the existing message and
  `CircleErrorCode.MemberLimit` code.
- Circle deletion during a transaction keeps the current not-found behavior.
- Invalid pagination values are rejected by Nest validation.
- Invalid or cross-scope cursors return a stable 400
  `CircleInvitationErrorCode.InvalidCursor` error without revealing the
  referenced invitation.
- Omitting pagination parameters produces the same response type and first
  page size as PR #56.
- No response DTO, database schema, or frontend deployment coordination is
  required.

## Verification

Follow test-driven development and add failing tests before implementation.

Capacity coverage:

- Unit-test the shared conditional update and both callers' rollback/error
  paths.
- Preserve tests for duplicate targets, already-active members, reactivation,
  and accurate affected-row counting.
- Add a PostgreSQL-backed concurrency test that starts with one remaining seat
  and admits two different users through concurrent transactions. Exactly one
  succeeds; the other receives `MemberLimit`; the final active-member count and
  `memberCount` equal the configured maximum.
- Cover competition between the two public admission paths if the e2e harness
  can exercise both without external OpenIM dependencies; otherwise cover the
  shared helper concurrently and unit-test both integrations.

Pagination coverage:

- Validate default, minimum, maximum, and rejected limits.
- Prove deterministic ordering when multiple rows share `createdAt`.
- Prove page two contains older rows with no duplicates or gaps.
- Prove traversal continues after the cursor invitation leaves `PENDING`.
- Reject a cursor belonging to another user, endpoint scope, or circle.
- Preserve the circle owner/admin authorization check on every page.

Finally run the focused group, invitation, DTO, and controller suites; the
database-backed concurrency test; lint/type checking; and the project build.
