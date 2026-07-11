# Production Review Remediation Design

## Goal

Resolve every actionable bug found in the production review of
`feat/friend-request-annotations` while preserving existing user data and avoiding
new infrastructure dependencies.

The product decision is explicit: circles no longer have a public/private mode.
Every circle membership request requires review through the invitation and
verification workflow.

## Scope and delivery units

The work is one coordinated release but is implemented and verified in four
bounded units:

1. Circle membership review consistency.
2. Friend-request concurrency and OpenIM reliability.
3. Notification, Expo push, profile, and trace-comment reliability.
4. Operational script safety and repository quality gates.

Each unit gets its own implementation-plan section and focused tests. Database
migrations are additive and ordered so a fresh database and an existing database
reach the same final schema.

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
  each `(circleId, applicantId)` pair. The migration resolves any existing
  duplicates deterministically before creating the index.
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
  return the existing domain conflict/not-found response and perform no
  activities, notifications, outbox writes, or OpenIM actions.
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

### OpenIM outbox

- Extend the existing friend-sync outbox instead of introducing Redis, BullMQ,
  Kafka, or a second job system.
- Every job has a stable deduplication key. Accepting a request enqueues imports
  and one accepted-thread replay job transactionally. Removing a friend enqueues
  friend deletion and conversation clearing transactionally.
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
- Keep at most 10 active tokens per user. Registering an eleventh token disables
  or removes the oldest token in the same transaction.
- Fetches remain bounded and messages are grouped by `projectId` before batching.
- Add a Prisma-backed push delivery outbox keyed by notification and device token.
  It records attempts, next-attempt time, Expo ticket ID, receipt state, and the
  final result.
- Retry network errors and HTTP 429/5xx with exponential backoff. Poll Expo
  receipts from persisted ticket IDs. Disable tokens reported as
  `DeviceNotRegistered`; retain actionable terminal errors for operations.
- Notification creation and delivery rows are committed together so an app crash
  cannot silently lose offline delivery.

### Profile and notification correctness

- OpenIM receives the normalized nickname returned by the database update, not
  raw request input.
- Add a Prisma-backed user-profile sync outbox so transient OpenIM failures are
  retried. Newer profile updates supersede older pending payloads per user.
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

1. Add new enum values, relations, outbox columns/tables, and indexes.
2. Repair legacy pending circle memberships and resolve duplicate pending circle
   invitations before enabling the unique index.
3. Drop `Circle.isPublic` only after application code no longer reads or writes it.
4. Deploy processors with safe bounded batches; existing rows are unaffected
   unless they require the explicit circle repair migration.

The migration chain must apply from an empty PostgreSQL database and produce no
schema drift. Rollback is performed by application rollback plus a forward data
migration; destructive down migrations are not added.

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
