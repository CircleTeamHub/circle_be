# Plaza Signup Membership Design

## Goal

Prevent a user from signing up for a plaza post unless the user is an active
member of at least one non-deleted circle linked to that post.

## Context

`signupForPost` currently loads any active, unexpired post whose primary circle
is not deleted. That permits a caller who is not a member of any linked circle
to proceed to the signup eligibility checks and create a signup.

Other plaza operations already express circle membership through
`memberCircleScope(userId)` and the post's `circleLinks` relation.

## Approaches Considered

1. Select the requesting user's eligible linked circles with the existing post
   lookup, preserve the existing-signup fast path, and reject a new signup when
   that selected relation is empty. This is the selected approach because it
   reuses an established authorization pattern without adding a database round
   trip.
2. Query circle membership separately before loading the post. This adds a
   database round trip and creates an avoidable time-of-check/time-of-use gap.
3. Keep allowing non-members to sign up. This conflicts with the product rule
   that circle post participation is limited to active members.

## Design

Change the `signupForPost` lookup to select at most one `circleLinks` row whose
circle matches `memberCircleScope(userId)`. The post remains discoverable to the
service when the caller is not a member so that the existing-signup fast path
can run, but no post data is returned to the client. The lookup must accept a
post whose primary circle is deleted when a non-deleted secondary linked circle
still qualifies. No DTO, schema, or response shape changes are needed.

When no qualifying post is found, retain the existing `PostNotFound` error. This
does not disclose the existence of a post that the caller cannot participate
in and keeps the endpoint's existing error contract.

Membership is required when creating a new signup. If a signup already exists,
the endpoint preserves its current idempotent success response even when the
user has since left all linked circles. Existing signup data is not deleted by
this endpoint and can still be cancelled through the existing cancel endpoint.

The guard authorizes against the membership state observed by the initial post
lookup. It does not attempt to serialize signup with a concurrent membership
revocation or circle unlink. That stronger cross-aggregate guarantee would
require expanding the existing signup transaction and retry behavior and is
outside this focused fix; the chosen behavior matches the point-in-time
authorization used by the other plaza operations.

## Verification

Add focused service tests that assert all of the following:

- The lookup uses `circleLinks.some.circle`, so membership in any linked circle
  qualifies rather than only membership in the primary circle.
- The nested circle scope requires `deleted: false` and an `ACTIVE` membership
  for the requesting user, excluding pending/rejected memberships and deleted
  or unlinked circles through the query predicate.
- A new signup with no eligible linked circle returns the exact `PostNotFound`
  error code and performs no entitlement lookup or signup write.
- An existing signup remains idempotently successful after membership loss.

Add a database-backed e2e test matrix that executes the Prisma relation filters
against PostgreSQL and proves:

- Active membership in a non-primary linked circle succeeds, including when the
  primary circle is deleted.
- Pending or rejected membership is rejected.
- Active membership only in a deleted or unlinked circle is rejected.
- An existing signup remains idempotently successful after membership loss and
  does not increment the stored signup count again.

Run the focused service test before the implementation to demonstrate the
regression, then run the complete Circle Plaza service test suite, the
database-backed e2e test, and the project build after the fix.
