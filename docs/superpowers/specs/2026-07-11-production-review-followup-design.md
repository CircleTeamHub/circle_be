# Production Review Follow-up Design

## Goal

Resolve every actionable finding from the production review of
`feat/friend-request-annotations` without changing the product decision that
all circle joins require review.

## Constraints

- Treat all existing migrations as potentially applied. Never rewrite or
  remove them.
- Keep API behavior backward compatible except where the branch already
  intentionally removed public-circle semantics.
- Use forward-only migrations, transaction-scoped locks, and compare-and-set
  worker transitions.
- Add a regression test for every finding before changing production code.
- Avoid unrelated refactors and new infrastructure dependencies.

## Migration Compatibility

The existing `20260710020000_drop_circle_is_public` migration may already be
recorded in shared environments. A new forward migration will restore the
physical `Circle.isPublic` column with a non-null default. The Prisma model will
retain the compatibility field, while controllers, DTOs, and services continue
to ignore it. This keeps old application instances operational during rolling
deployments. The column can be removed only in a later release after all old
instances and clients are retired.

The same forward migration will add worker lease/version columns needed by the
profile-sync and chat-replay outboxes. Existing rows receive safe defaults so
pending work remains processable.

## Durable Worker Claims

### Profile synchronization

`UserProfileSyncOutbox` will carry a monotonically increasing generation.
Every nickname/avatar update increments the generation while resetting the row
to `PENDING`. A worker claims one observed generation, loads the latest user
profile only after the claim succeeds, and marks the job complete only when the
generation still matches. If another profile update supersedes the job, the old
worker cannot erase the new request.

### Friend chat replay

`FriendChatReplayOutbox` will use a unique lease token for each claim. Pending,
failed, and stale-processing claims all compare the observed state and lock
metadata. Progress, completion, and failure writes require the same lease token.
Losing workers stop without changing the row. Existing deterministic OpenIM
message IDs remain as a second idempotency layer.

### Notification push

Push jobs will set `lockedAt` from the actual claim time instead of the batch
query time. Terminal writes will compare the active lease. This prevents a long
batch from creating immediately stale claims and prevents an expired worker
from overwriting a newer result.

## Circle Consistency

The invitation reconciler will select threshold-eligible rows directly rather
than repeatedly scanning the oldest arbitrary pending rows. Selection will be
bounded and deterministic. Each candidate will be processed independently so
one full circle or transient failure cannot block later candidates.

Joining, leaving, invitation finalization, and administrative approval will use
the same applicant/circle advisory-lock key. `leaveCircle` will load membership
inside the transaction after acquiring the lock and derive `memberCount`
changes from that current row. This prevents approval/leave races from deleting
an active membership without decrementing the count.

Cancelling an application will make verifier tasks immediately undiscoverable.
Pending-verification queries will require the parent invitation to remain
`PENDING`; cancellation tests will cover both listing and response behavior.

## Notification Correctness

Expo HTTP success is not delivery success. Every returned ticket will be
examined. `DeviceNotRegistered` remains terminal and disables the token;
retryable ticket errors cause the outbox job to retry; other terminal errors are
recorded and do not masquerade as successful delivery. Mixed batches return
failure when any retryable ticket fails.

All friend request lifecycle notifications (received, accepted, rejected, and
message) will persist `fromFriendRequestID`. Realtime and push DTOs will
therefore expose the same `requestId` deep link for every lifecycle event.

## Testing

Focused Jest tests will cover:

- an in-flight profile sync superseded by a newer generation;
- competing stale chat-replay workers and lease-protected terminal writes;
- push claims created late in a long batch and stale-worker terminal writes;
- more than 100 ineligible invitations before an eligible repair;
- one failing invitation not blocking the next candidate;
- concurrent leave/final approval using current transactional state;
- cancelled invitations disappearing from verifier worklists;
- Expo retryable, terminal, and mixed ticket responses;
- `requestId` on every friend lifecycle notification;
- the compatibility migration and final Prisma schema alignment.

Final verification requires focused suites, the full Jest suite, TypeScript
build checking, Nest build, Prisma validation, migration drift checks, and
`git diff --check`.

## Release Sequence

1. Apply the new forward compatibility/outbox migration.
2. Roll out the corrected application workers and services.
3. Observe outbox failure counts and circle reconciliation until stable.
4. Keep `Circle.isPublic` physically present for at least one independent
   release; its eventual removal is explicitly outside this change.
