# WindNote Admin User Management Center Design

**Date:** 2026-07-21

**Status:** Approved for implementation planning

**Repositories:**

- `CircleTeamHub/circle_be`
- `CircleTeamHub/circle_admin_web`

## Summary

Upgrade the existing WindNote Admin from a basic user table into a secure user
management center. The first release adds server-side search, a user 360-degree
detail page, masked personal data with audited reveal, safe account status
actions, user-level audit history, and a placeholder for the future monthly VIP
system.

The feature uses dedicated `/api/v1/admin/users` endpoints. It does not extend
the App-facing `/api/v1/user` response because public profile contracts and
Admin contracts have different privacy and authorization requirements.

## Goals

- Let an administrator find users by identity, contact, status, role, and
  registration time.
- Present account, security, synchronization, and business-summary information
  in one detail page.
- Mask contact information by default and audit every reveal of an original
  value.
- Allow safe ban, unban, and soft-delete operations with explicit reasons.
- Revoke all user sessions when a user is banned or deleted.
- Provide a queryable, immutable audit trail for sensitive reads and status
  changes.
- Preserve the existing `JwtGuard + AdminGuard` authorization boundary.
- Reserve a visible place for the future monthly VIP design without reading or
  mutating the legacy permanent `vipLevel` field.

## Non-goals

- Monthly VIP plans, expiry dates, payment verification, VIP grants, or VIP
  redemption codes.
- Restoring a user whose status is `DELETED`.
- Temporary bans that expire automatically.
- Fine-grained Admin roles such as support, moderator, finance, or read-only
  operations.
- Content moderation, Dashboard expansion, runtime events, queue management,
  or infrastructure dashboards.
- Editing ordinary profile fields such as nickname, avatar, city, or contact
  information.
- Returning password hashes, login security-code hashes, refresh tokens, or
  other authentication secrets to the Admin frontend.

## Confirmed Product Decisions

- VIP is becoming a monthly product and its final model is not yet designed.
  The first release displays a placeholder only.
- Contact information is masked by default. Viewing an original value requires
  a reason and creates an audit row.
- A ban remains active until an administrator manually unbans the user.
- Banning and deleting revoke current sessions.
- The first release keeps the existing `ADMIN` role and ADMIN token audience.
- `DELETED` is a terminal state in this UI.

## Architecture

### Backend boundary

Create a focused Admin user feature module in `circle_be`:

- `AdminUserController`: validates HTTP input and delegates to services.
- `AdminUserService`: performs Admin-only reads, aggregation, masking, reveal,
  and status transitions.
- `AdminAuditService`: creates and queries audit rows through a narrow API.
- Admin user DTOs: define list filters, detail responses, reveal requests, and
  status requests.

Every route uses both `JwtGuard` and `AdminGuard`. `AdminGuard` remains the
server-side authorization boundary; frontend route protection is only a user
experience convenience.

The ordinary `UserController` and its public profile selects remain unchanged.
Existing lower-level status side effects are reused where safe, including
refresh-token revocation, access-token revocation, realtime cache invalidation,
and profile-summary broadcast. The Admin service owns transition validation and
audit transaction boundaries.

### Frontend boundary

Extend `circle_admin_web` with:

- `/users`: searchable and filterable user list.
- `/users/:userId`: user detail route.
- A dedicated Admin user API client.
- Focused detail sections for identity, contacts, security, business summary,
  VIP placeholder, dangerous actions, and audit history.
- An in-memory sensitive-value reveal state that automatically clears after 60
  seconds and is never persisted.

## User Experience

### User list

The list supports these server-side filters:

- `keyword`: case-insensitive partial match on account ID, nickname, email, or
  phone number.
- `status`: `ACTIVE`, `BANNED`, or `DELETED`.
- `role`: `USER`, `MEMBER`, or `ADMIN`.
- `createdFrom` and `createdTo`: ISO-8601 timestamps.
- `page`: integer greater than or equal to 1.
- `limit`: integer from 1 through 100; the UI uses 20.

The table shows avatar, account ID, nickname, masked email, masked phone,
status, role, registration time, and last-online time. The row action is
`查看详情`; status actions are intentionally kept off the table to reduce
mistakes.

### User detail

The page contains these sections:

1. **Account profile**: avatar, account ID, nickname, role, status, city,
   region, gender, registration time, update time, and last-online time.
2. **Contact information**: email, phone, WeChat, QQ, and WhatsApp. Each field
   is masked and revealed independently.
3. **Security and synchronization**: login-security lock state, single-device
   login setting, active session count, active push-device count, and OpenIM
   synchronization state.
4. **Business summary**: credit score, wallet balance, accepted friend count,
   note count, trace count, circles owned, active circle memberships, reports
   filed, and reports received.
5. **VIP**: a disabled card containing the copy `新的月度 VIP 系统设计中`.
6. **Dangerous actions**: ban, unban, and soft-delete controls allowed by the
   state-transition table.
7. **Recent Admin activity**: the 20 newest audit rows targeting this user.

### Sensitive-value reveal

The administrator selects one contact field, enters a reason or support-ticket
reference, and confirms the reveal. The backend writes the audit event before
returning the original value. The frontend displays the value for 60 seconds,
then returns to the masked representation.

Sensitive values must not be written to URL state, browser storage, application
logs, analytics, error messages, Sentry context, or audit metadata. Navigating
away from the page clears all revealed values immediately.

### Status actions

Valid transitions are:

| Current state | Allowed target | UI action |
| --- | --- | --- |
| `ACTIVE` | `BANNED` | 封禁 |
| `ACTIVE` | `DELETED` | 删除 |
| `BANNED` | `ACTIVE` | 解封 |
| `BANNED` | `DELETED` | 删除 |
| `DELETED` | none | read-only |

Every transition requires a reason between 3 and 500 characters. Deletion also
requires the administrator to type the target user's exact account ID. The
backend validates both requirements and forbids an administrator from banning
or deleting their own user ID.

## API Contracts

All routes below are relative to `/api/v1`.

### List users

`GET /admin/users`

Query parameters follow the user-list filters above. The response is:

```ts
type AdminUserListResponse = {
  items: Array<{
    id: string;
    accountId: string;
    nickname: string;
    avatarUrl: string | null;
    maskedEmail: string | null;
    maskedPhoneNumber: string | null;
    role: 'USER' | 'MEMBER' | 'ADMIN';
    status: 'ACTIVE' | 'BANNED' | 'DELETED';
    createdAt: string;
    lastOnline: string | null;
  }>;
  total: number;
  page: number;
  limit: number;
};
```

### Get user detail

`GET /admin/users/:id`

The response contains the non-secret profile fields, masked contact fields,
security flags, synchronization flags, active-session and active-device
counts, and the business-summary counts defined in the user experience.
Missing wallets produce a balance of zero. No original contact value is
included.

### Reveal one sensitive field

`POST /admin/users/:id/sensitive-access`

```ts
type SensitiveAccessRequest = {
  field: 'email' | 'phoneNumber' | 'wechat' | 'qq' | 'whatsup';
  reason: string; // 3..500 characters
};

type SensitiveAccessResponse = {
  field: SensitiveAccessRequest['field'];
  value: string | null;
  revealedAt: string;
  expiresAt: string; // revealedAt + 60 seconds; enforced by the UI
};
```

If the audit insert fails, the endpoint returns an error and does not return
the value.

### Change user status

`PATCH /admin/users/:id/status`

```ts
type AdminUserStatusRequest = {
  status: 'ACTIVE' | 'BANNED' | 'DELETED';
  reason: string; // 3..500 characters
  confirmationAccountId?: string; // required for DELETED
};
```

The response is the updated non-secret account status summary. No-op updates
are rejected and do not create audit rows.

### List audit activity

`GET /admin/users/:id/audit-logs?limit=20`

The endpoint returns at most 100 rows, newest first. The Admin user detail page
uses a limit of 20. Audit data never includes revealed contact values.

## Masking Rules

Masking occurs only on the backend:

- Email: preserve the first local-part character and the domain, for example
  `j***@example.com`.
- Phone: preserve only the final four characters, for example `*******1234`.
- WeChat, QQ, and WhatsApp: preserve the first and final character when the
  value has more than two characters; otherwise replace the whole value with
  `**`.
- Null remains null.

The same masking helpers are used for list and detail responses and have
focused unit tests.

## Audit Data Model

Add this append-only Prisma model:

```prisma
model AdminAuditLog {
  id             String   @id @default(uuid())
  actorId        String
  actorAccountId String
  action         String
  targetType     String
  targetId       String
  before         Json?
  after          Json?
  reason         String?
  metadata       Json?
  requestId      String?
  ip             String?
  userAgent      String?
  createdAt      DateTime @default(now())

  @@index([targetType, targetId, createdAt])
  @@index([actorId, createdAt])
  @@index([action, createdAt])
}
```

The first release defines these action constants:

- `USER_SENSITIVE_FIELD_VIEWED`
- `USER_BANNED`
- `USER_UNBANNED`
- `USER_DELETED`

The audit table intentionally has no cascading foreign key to `User`; an audit
row must survive user soft deletion and future account-retention changes.
Status audit `before` and `after` contain only the status value. Sensitive-read
metadata contains only the field name. Audit rows have no delete endpoint and
are retained indefinitely in this release.

## Transaction and Concurrency Rules

Status transitions execute in a database transaction:

1. Read the current account ID and status.
2. Validate self-protection, transition, reason, and deletion confirmation.
3. Conditionally update the row using the current status in the predicate.
4. Revoke all unrevoked refresh-token rows for ban or deletion.
5. Insert the Admin audit row.
6. Commit.

If the conditional update matches zero rows, another administrator changed the
state concurrently. Return HTTP 409 and require the frontend to reload. The
losing request does not write an audit row.

After commit, invoke the existing access-token revocation service and realtime
cache/profile-summary invalidation. The database transaction guarantees that a
user cannot retain a refresh session after the status change. The existing
server-side revocation path rejects already-issued access tokens under normal
Redis availability.

Sensitive reveal performs the user read and audit insert before constructing
the response. Audit failure is fail-closed.

## Errors

Use stable error codes with the existing application error-envelope format:

- `ADMIN_USER_NOT_FOUND`: HTTP 404.
- `ADMIN_USER_SELF_STATUS_CHANGE`: HTTP 403.
- `ADMIN_USER_INVALID_STATUS_TRANSITION`: HTTP 409.
- `ADMIN_USER_STATUS_CONFLICT`: HTTP 409.
- `ADMIN_USER_CONFIRMATION_MISMATCH`: HTTP 400.
- `ADMIN_USER_SENSITIVE_FIELD_INVALID`: HTTP 400.
- `ADMIN_USER_SENSITIVE_REASON_REQUIRED`: HTTP 400.
- `ADMIN_AUDIT_UNAVAILABLE`: HTTP 503 for fail-closed reveal failures.

The frontend displays the server message and request ID. HTTP 401 clears the
Admin session and returns to `/login`; HTTP 403 keeps the session and explains
that the current administrator lacks permission.

## Observability and Privacy

- Emit a redacted business/security log for each successful status mutation
  with actor ID, target ID, action, result, and request ID.
- Do not add user IDs, account IDs, contact data, IP addresses, or reasons as
  Prometheus label values.
- Do not log request bodies for sensitive-access or status endpoints.
- Preserve request ID, IP, and user-agent context in the audit row after
  applying the repository's existing length limits.
- A failed realtime broadcast must be logged but must not roll back a committed
  status change.

## Testing

### Backend

- DTO validation for pagination, filters, date ranges, fields, reasons, and
  confirmation account IDs.
- Admin guard allow and deny behavior for each new route.
- Masking helpers for null, short, ordinary, and malformed-but-stored values.
- List response excludes original contact values and authentication secrets.
- Detail aggregation returns correct counts and zero for a missing wallet.
- Sensitive reveal writes an audit row before returning and fails closed when
  audit persistence fails.
- Sensitive audit metadata contains only the field name.
- Every valid and invalid status transition.
- Self-ban and self-delete rejection.
- Deletion account-ID confirmation.
- Transaction rollback when audit creation fails.
- Concurrent status mutation permits exactly one winner.
- Ban and deletion revoke refresh rows and invoke access-token revocation.
- HTTP tests for 400, 401, 403, 404, 409, 503, and successful responses.

### Admin frontend

- Query-string construction and filter reset behavior.
- User-list rendering with only masked contacts.
- User-detail sections and business-summary values.
- Sensitive reason validation, reveal, 60-second remasking, and cleanup on
  unmount.
- Valid action visibility for each status.
- Self-action disabled state as defense in depth.
- Delete account-ID confirmation.
- Successful mutation invalidates list, detail, and audit queries.
- 401, 403, conflict, and general API error presentation.
- VIP card contains only the placeholder and exposes no mutation control.

## Rollout

1. Apply the `AdminAuditLog` migration and deploy `circle_be` with the new
   endpoints.
2. Smoke-test the new endpoints with a test Admin token while the existing
   Admin frontend remains deployed.
3. Deploy `circle_admin_web` with the new routes.
4. Verify user search, masked detail, one sensitive reveal, ban, and unban on a
   test user.
5. Verify soft deletion only on a disposable test user and confirm that its
   refresh sessions are revoked.
6. Monitor 4xx/5xx rates, audit inserts, and revocation errors during rollout.

Backend deployment precedes frontend deployment, so the rollout is backward
compatible with the existing Admin application.

## Success Criteria

- An Admin can search for a user and open a complete operational summary.
- Original contact data never arrives at the frontend until an audited reveal.
- Every reveal and every status mutation produces a queryable audit row without
  storing sensitive values.
- Invalid, self-directed, repeated, and concurrent status operations are
  rejected server-side.
- Ban and deletion revoke user sessions using the existing revocation system.
- A DELETED user cannot be restored from this release's UI or API.
- The Admin frontend has a visible VIP placeholder and no legacy VIP mutation.
- Backend targeted tests, backend build, Admin tests, Admin typecheck, and Admin
  build complete successfully before release.
