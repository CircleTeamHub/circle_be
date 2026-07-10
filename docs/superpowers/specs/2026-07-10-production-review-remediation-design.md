# Production Review Remediation Design

## Goal

Resolve every actionable bug found in the production review of
`feat/friend-request-annotations` while preserving existing user data and avoiding
new infrastructure dependencies.

The product decision is explicit: circles no longer have a public/private mode.
Every circle membership request requires review through the invitation and
verification workflow.

## Scope and delivery units

The work is one coordinated remediation, implemented and verified in four
bounded units and rolled out through the two deployments defined below:

1. Circle membership review consistency.
2. Friend-request concurrency and OpenIM reliability.
3. Notification, Expo push, profile, and trace-comment reliability.
4. Operational script safety and repository quality gates.

Each unit gets its own implementation-plan section and focused tests. Database
migrations are forward-only and ordered so a fresh database and an existing
database reach the same final schema. Forward-only does not mean additive: the
final contract migration intentionally drops `Circle.isPublic`.

## 1. Circle membership review consistency

### Domain contract

- Remove `Circle.isPublic` from Prisma, generated DTOs, API inputs/outputs, query
  projections, fixtures, and tests. No compatibility alias remains.
- `POST /circle/:id/join` always creates or returns a pending review application.
- The endpoint returns HTTP 202 with the complete `InvitationDto`, including the
  invitation ID and current approval counts.
- An ACTIVE member still receives a conflict. A PENDING member receives the
  existing pending invitation. If legacy data contains a PENDING membership but
  no invitation, the request repairs the record by creating the missing
  invitation and returns it.

### Consistency

- Direct join and member-invite entry points acquire the same transaction-scoped
  advisory lock for `(circleId, applicantId)` before looking for or creating a
  pending invitation.
- A database partial unique index guarantees at most one PENDING invitation for
  each `(circleId, applicantId)` pair. Before creating the index, the migration
  chooses the canonical invitation by earliest `(createdAt, id)`, moves the union
  of unique verifier records onto it, and resolves duplicate verifier states with
  precedence `APPROVED > PENDING > REJECTED`. It sets `requiredCount` to the
  maximum of the duplicate invitations, recomputes `approvedCount` from merged
  APPROVED verifiers, and marks the remaining invitations CANCELLED.
- For a legacy PENDING membership with no invitation, synthesize one with
  `inviterID = applicantID`, `requiredCount = 10`, `approvedCount = 0`, and
  `status = PENDING`.
- Deduplication never admits members inside raw migration SQL. After Deployment A,
  an idempotent reconciliation command selects canonical PENDING invitations with
  `approvedCount >= requiredCount` and runs the same transactional finalization
  path as a live approval, including membership/memberCount changes,
  notifications, and group-sync outbox work. Deployment A is incomplete until
  this query returns zero rows.
- Add `CANCELLED` to `CircleInvitationStatus`. Leaving while membership is
  PENDING cancels all pending invitations for that applicant and circle in the
  same transaction. Cancelled invitations can never admit the applicant.
- Existing `isPublic` data is discarded when its column is dropped; no circle is
  auto-admitted after the migration.

### Verification

- Unit tests cover response status and DTO changes.
- PostgreSQL integration tests cover legacy repair, duplicate join idempotency,
  join-vs-invite concurrency, transaction rollback, and cancellation followed by
  verifier/admin action.

## 2. Friend-request concurrency and OpenIM reliability

### Message-thread invariants

- A friend-request thread has a hard total limit of 50 messages and retains the
  existing sender-before-reply soft limit of 5 messages.
- Append, accept, reject, and cancel acquire the same request-scoped advisory
  lock and re-read request state inside the transaction.
- Only one transition from PENDING can succeed. Losing concurrent operations
  perform no activities, notifications, outbox writes, or OpenIM actions. Append
  against a non-PENDING request returns HTTP 409 with
  `FRIEND_REQUEST_NOT_PENDING`. Accept, reject, and cancel that lose a concurrent
  transition return HTTP 409 with `FRIEND_REQUEST_ALREADY_HANDLED`.
- Thread queries order by `createdAt` and then `id` for deterministic replay.

### Durable discovery

- Add a `REQUEST_MESSAGE_RECEIVED` friend-activity type. Each new message updates
  or creates a durable activity for the recipient, resets it to unread, and
  stores the latest message snapshot.
- Friend-request notifications carry `requestId` in persisted data, realtime
  DTOs, and Expo payloads so clients can navigate to the specific request.
- Friend request RECEIVED/ACCEPTED/REJECTED notifications remain in the legacy
  notification-bell contract for a compatibility window while the dedicated
  friend-activity inbox remains authoritative.

### `CHAT_ONLY` privacy contract

- `permissionA` is the visibility grant made by the friend record's `userID` side
  to `friendID`; `permissionB` is the grant made by `friendID` to `userID`.
- When an author's grant toward a viewer is `CHAT_ONLY`, that viewer cannot see
  the author's traces through feed, new-count, direct detail, like, or comment
  entry points. Direct access behaves as not found and must not reveal that a
  hidden trace exists.
- The rule is asymmetric. A's `CHAT_ONLY` grant toward B does not hide B's traces
  from A unless B's own grant toward A is also `CHAT_ONLY`.
- Accepting a request promotes only the requester's staged grant into the
  requester-owned slot; the recipient's slot retains its existing/default value.

### OpenIM outbox

- Extend the existing friend-sync outbox instead of introducing Redis, BullMQ,
  Kafka, or a second job system.
- Every job has a stable deduplication key. Accepting a request enqueues one
  composite `FINALIZE_ACCEPTED_CHAT` job transactionally. Its persisted state
  machine is: import requester side, import accepter side, replay message index
  0..N, send accepted reply, DONE. A later stage cannot run until every earlier
  stage is persisted complete. Removing a friend enqueues friend deletion and
  conversation clearing transactionally.
- The processor retries transient failures with the existing backoff policy.
  Accepted-thread replay uses deterministic client message IDs and disables
  offline push for historical messages. Progress is persisted so a retry cannot
  duplicate already-imported messages.
- Conversation clearing sends OpenIM's explicit self-sync option and is retried
  until completed or moved to the existing terminal-failure state.

### Verification

- Unit tests first reproduce concurrent cap bypass, append-after-accept, duplicate
  accept, duplicate outbox, replay push, and partial replay retry.
- PostgreSQL integration tests run real concurrent transactions.
- OpenIM remains mocked at the HTTP boundary, with exact payload assertions.

## 3. Notification and profile reliability

### Expo push delivery

- Accept only syntactically valid Expo push tokens.
- Keep at most 10 active tokens per user. Registering an eleventh token deletes
  the oldest active token in the same transaction. Registering a token already
  owned by another user atomically transfers it to the current user before the
  current user's limit is enforced; it no longer counts toward the old owner.
- Fetches remain bounded and messages are grouped by `projectId` before batching.
- Add a Prisma-backed push delivery outbox keyed by notification and device-token
  identity. Each delivery also stores immutable snapshots of recipient user ID,
  token string, project ID, and payload so history survives token deletion. The
  token foreign key is nullable with `onDelete: SetNull`. It records attempts,
  next-attempt time, Expo ticket ID, receipt state, and the final result.
- Retry network errors and HTTP 429/5xx with exponential backoff. Poll Expo
  receipts from persisted ticket IDs. Disable tokens reported as
  `DeviceNotRegistered`; retain actionable terminal errors for operations.
- Notification creation and delivery rows are committed together so an app crash
  cannot silently lose offline delivery.
- When a token transfers to a new user, the registration transaction marks every
  unsent PENDING/RETRY delivery for the old owner CANCELLED before changing token
  ownership. Receipt-pending rows are not resent and may only complete receipt
  polling against their immutable snapshot. Limit enforcement runs after transfer
  and excludes the newly registered token from eviction; older active tokens are
  removed first.

### Profile and notification correctness

- OpenIM receives the normalized nickname returned by the database update, not
  raw request input.
- Add a Prisma-backed user-profile sync outbox so transient OpenIM failures are
  retried. Each user has one row with a monotonically increasing payload version.
  A worker reads the latest payload immediately before sending and compares the
  version again after the call; it marks DONE only if the version is unchanged.
  If an update arrived while the older call was in flight, the row remains
  pending and the newest payload is sent again, guaranteeing the newest profile
  becomes the final OpenIM state.
- Invalid notification page values are rejected through a validated query DTO
  instead of passing `NaN` to Prisma.
- `PROFILE_LIKE` gets a dedicated push message.

### Trace image comments

- Normalize comment images by trimming values and reject blank entries. A comment
  is valid only when it has non-empty text or at least one valid image URL.
- Notification DTOs include enough comment-image information to produce a
  dedicated image-comment summary. Pure-image comments never reuse the original
  trace text as the push body.

### Verification

- Tests cover token validation and eviction, project grouping, transient retry,
  receipt handling, notification/request deep links, nickname normalization,
  profile-sync retry, invalid pagination, blank image arrays, image-comment push,
  and profile-like push.

## 4. Operational safety and quality gates

### `set-vip`

- The script fails closed when `DATABASE_URL` is absent; it has no hard-coded
  database fallback.
- Accept `--id <uuid>` or `--nickname <name>`. Nickname ambiguity never mutates a
  user and points to the supported ID command.
- VIP level must be a safe integer from 0 through 5.
- Argument parsing and selection are extracted into testable pure functions.

### Quality

- Fix all CI-equivalent ESLint/Prettier errors introduced by the branch.
- Do not rewrite the branch's existing commit history solely to reduce review
  size. Fixes are committed in bounded logical units so they can be reviewed and
  reverted independently.
- No unrelated refactors or dependency upgrades are included.

## Error handling and observability

- Domain conflicts use existing structured NestJS exceptions and application
  error codes.
- Outbox processors log job identifiers, entity identifiers, attempts, and final
  dispositions without logging tokens or message contents.
- Retryable and terminal external-service errors are distinguished explicitly.
- Scheduled processors use bounded batch sizes and claim jobs atomically.

## Migration and rollout

This is an explicit two-deployment expand/contract rollout; it is not deployed as
one atomic application release:

1. **Deployment A — expand and behavior change:** add enum values, relations,
   outbox state, forward-compatible columns/tables, and indexes; repair legacy
   pending memberships and merge duplicate pending invitations; deploy code that
   no longer reads or writes `isPublic` while the physical column remains. Run
   the invitation reconciliation command and require zero threshold-met PENDING
   invitations before continuing.
2. Wait until every old application instance has drained and verify no deployed
   query references `isPublic`.
3. **Deployment B — contract:** apply the final migration that drops the physical
   `isPublic` column and deploy the generated Prisma client/schema without the
   field. This deployment must not start while Deployment-A-incompatible old
   instances are running. If the platform cannot guarantee draining, use a short
   maintenance window for this contract step.
4. Deploy processors with safe bounded batches. Existing rows are unaffected
   except for the explicit circle repair/deduplication migration.

The committed branch contains both final-state deployments as separately
reviewable commits. Operators must land/deploy the Deployment A commit before the
Deployment B commit. The final migration chain applies from an empty PostgreSQL
database and produces no schema drift. Rollback uses application rollback plus a
new forward data migration; destructive down migrations are not added.

## Review finding traceability

| Review finding | Requirement | Required regression evidence |
| --- | --- | --- |
| 1. CI lint failure | Quality section | CI-equivalent ESLint exits zero |
| 2. Legacy circle PENDING stuck | Circle consistency repair | Legacy membership integration test |
| 3. Join API contract mismatch | Circle domain contract | 202 response/InvitationDto e2e |
| 4. Leave does not cancel invitation | Circle CANCELLED invariant | Leave-then-approve integration test |
| 5. Friend message has no unread surface | Durable discovery | Offline discovery/activity test |
| 6. Unbounded request thread | 50-message hard limit | Boundary and concurrent-limit tests |
| 7. Unlimited push tokens | Token limit | Eleventh-token eviction test |
| 8. Append race | Request-scoped lock | Concurrent append/accept DB test |
| 9. Duplicate accept/reject effects | Atomic transition and dedupe key | Concurrent decision DB test |
| 10. CHAT_ONLY coverage gap | Friend/privacy verification | Real-DB asymmetric privacy e2e |
| 11. Oversized review scope | Four delivery units | Bounded commits; no history rewrite |
| 12. `set-vip` database fallback | Fail-closed script | Missing-DATABASE_URL test |
| 13. Legacy friend-notification contract | Compatibility dual surface | Notification list/count test |
| 14. Join-vs-invite duplicate invitation | Shared lock and partial unique index | Concurrent entry-point DB test |
| 15. Conversation clear does not sync/retry | Clear outbox and self-sync option | Payload and retry tests |
| 16. Historical replay sends offline pushes | Replay payload contract | `notOfflinePush` assertion |
| 17. Replay is fire-and-forget | Composite durable state machine | Restart/partial-progress tests |
| 18. Expo transient failures/receipts lost | Push delivery outbox | Retry and receipt tests |
| 19. Mixed Expo projects | Project grouping | Multi-project batching test |
| 20. Blank image comment | Image normalization | `images: ['']` rejection test |
| 21. Wrong pure-image push body | Image-comment summary | Payload body test |
| 22. DB/OpenIM nickname mismatch | Normalized profile payload | Whitespace normalization test |
| 23. Profile sync has no retry | Versioned profile outbox | In-flight supersession test |
| 24. Invalid page becomes NaN | Validated query DTO | Invalid-page controller test |
| 25. Friend push lacks request ID | Persisted request relation | Realtime/push deep-link test |
| 26. Invalid VIP values/no tests | Argument validation | 0..5 and invalid-input tests |
| 27. Circle transaction tests are mocked | PostgreSQL verification | Rollback/concurrency DB tests |
| 28. Equal timestamps reorder messages | Secondary ID ordering | Deterministic ordering test |
| 29. Push commit too large | Delivery-unit decomposition | Focused notification commits |
| 30. `set-vip` ID hint unsupported | `--id` argument | Duplicate-nickname/ID tests |
| 31. PROFILE_LIKE generic body | Dedicated fallback | Type-specific payload test |

## Completion criteria

- Every production-review finding is either fixed by code/tests or documented as
  a non-code process observation.
- CI-equivalent lint, TypeScript compilation, production build, all unit tests,
  coverage thresholds, fresh-database migration deploy, schema drift check, and
  E2E tests pass.
- Focused regression tests demonstrate each race or failure before its fix and
  pass after implementation.
- The original `feat/plaza-post-multiselect` workspace and its uncommitted changes
  remain untouched.
