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

1. Add the membership scope to the existing post lookup. This is the selected
   approach because it is a single atomic query and reuses an established
   authorization pattern.
2. Query circle membership separately before loading the post. This adds a
   database round trip and creates an avoidable time-of-check/time-of-use gap.
3. Keep allowing non-members to sign up. This conflicts with the product rule
   that circle post participation is limited to active members.

## Design

Change the `signupForPost` lookup from checking only the primary circle's
deletion state to requiring at least one linked circle matching
`memberCircleScope(userId)`. No DTO, schema, or response shape changes are
needed.

When no qualifying post is found, retain the existing `PostNotFound` error. This
does not disclose the existence of a post that the caller cannot participate
in and keeps the endpoint's existing error contract.

## Verification

Add a focused service test that makes the scoped post query return no result,
asserts the lookup contains the active-member relation, and verifies that no
signup row is created. Run that test before the implementation to demonstrate
the regression, then run the complete Circle Plaza service test suite and the
project build after the fix.
