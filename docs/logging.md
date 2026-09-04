# Logging Guide

This project uses NestJS logging through `nest-winston`. Logs are structured
events (one JSON-ish object per line) with a shared request context, so a
single `x-request-id` ties together access, error, security, business and
external-service events.

- Make API behavior visible without ad-hoc `console.log`.
- Keep unit tests quiet by default.
- Never log secrets, PII, or request/response bodies.

Production-only work such as persistent audit logs, Datadog/Loki/CloudWatch
aggregation, and formal retention policies is intentionally deferred. Optional
**Sentry** error aggregation is available — see
[Error Aggregation (Sentry)](#error-aggregation-sentry).

## Environment Defaults

Development:

- `LOG_ON=true`
- `HTTP_LOG_ON=true`
- `SLOW_REQUEST_MS=1000`
- `BUSINESS_LOG_ON=true`
- `EXTERNAL_LOG_ON=true`
- `RATE_LIMIT_LOG_ON=true`
- `SECURITY_LOG_ON=true`
- `PERFORMANCE_LOG_ON=true`
- `SLOW_EXTERNAL_MS=1000`
- Console logs are human-readable.
- Rotated log files are written under root `logs/`.

Test:

- `LOG_ON=false`
- `HTTP_LOG_ON=false`
- `BUSINESS_LOG_ON=false`
- `EXTERNAL_LOG_ON=false`
- `RATE_LIMIT_LOG_ON=false`
- `SECURITY_LOG_ON=false`
- `PERFORMANCE_LOG_ON=false`
- Test output is quiet by default.
- E2E runs may explicitly enable error and slow request logs.

## Request Correlation

Every HTTP response includes `x-request-id`.

If a client sends a safe `x-request-id`, the backend reuses it. Otherwise the
backend generates a UUID. The request context (`requestId`, `traceId`,
`method`, `path`, `userId`) is stored in `AsyncLocalStorage` and stamped onto
every Winston line emitted during the request.

`userId` is bound by `JwtStrategy.validate` as soon as the bearer token is
verified — before guards, pipes and handlers run — so `http_error`,
`security_event` and Sentry tags carry the caller even when the request fails
early. (The access log used to learn the user only on `finish`.)

Use the request id to correlate:

- `http_access`
- `http_slow`
- `http_error`
- `rate_limit_hit`
- `business_event`
- `external_call_failed`
- `external_call_slow`
- `security_event`

## Event Types

- `http_access`: one event for each completed request.
- `http_slow`: warning event when request duration is above `SLOW_REQUEST_MS`.
- `http_error`: error event for thrown HTTP or server errors. Known Prisma
  request errors are logged with the status they map to (`P2002` → 409,
  `P2025` → 404, `P2003` → 400), not as 500s.
- `rate_limit_hit`: explicit limiter hit with limiter name.
- `business_event`: domain actions that operators and product care about —
  see the [catalogue](#business-event-catalogue). Every business event also
  increments `business_events_total{event,result}` regardless of log level.
- `external_call_failed`: a downstream dependency call failed — see
  [External services](#external-services).
- `external_call_slow`: warning event when a downstream call exceeds
  `SLOW_EXTERNAL_MS`.
- `security_event`: authentication / authorization signals — see the
  [catalogue](#security-event-catalogue).

Deferred production events:

- `audit_event`
- `db_query_slow`

## Business Event Catalogue

`src/logging/business-event.coverage.spec.ts` scans the codebase for every
`businessEvent` name and fails when one is missing from this list, so this
section is the authoritative inventory (and the review gate for the
`business_events_total` label budget of 100 names).

Auth & account:

- `auth_register_success`
- `auth_login_success`, `auth_login_failed`
- `auth_admin_login_success`, `auth_admin_login_failed`, `auth_admin_login_locked`, `auth_admin_logout`
- `auth_logout_all_success`, `auth_session_logout`, `auth_other_sessions_logout`
- `auth_password_reset_requested` (no actor — unauthenticated, email never logged), `auth_password_reset_success`
- `auth_change_password_success`, `auth_change_account_id_success`
- `auth_security_code_set`, `auth_security_code_disabled`
- `auth_single_device_login_changed`
- `auth_qr_login_approved`
- `user_account_removed`

Admin & moderation:

- `admin_user_status_changed`
- `membership_granted`
- `avatar_frame_granted`

Friends & blocks:

- `friend_request_sent`, `friend_request_withdrawn`, `friend_request_accepted`, `friend_request_rejected`
- `friend_removed`, `friend_reported`
- `friend_block_created`, `friend_unblocked`

Circles & groups:

- `circle_created`, `circle_join_requested`, `circle_left`
- `group_member_role_updated`, `group_member_removed`, `group_left`, `group_reported`

Money, credits & commerce:

- `coin_gift_sent`
- `fancy_number_purchased`, `fancy_number_renewed`, `fancy_number_converted_permanent`
- `group_expansion_purchased`
- `referral_rewarded`

Content:

- `plaza_post_created`
- `moment_created`
- `note_share_link_created`, `note_share_link_revoked`
- `temp_chat_created`, `temp_chat_ended`

Calls:

- `call_started`, `call_accepted`, `call_rejected`, `call_cancelled`

Payload shape: `actorId` (who did it), `targetId` (who it was done to),
`entityType` / `entityId` (what changed), `result` (`success` / `failure`) and
a small `metadata` object. `metadata` is filtered through a sensitive-key
denylist (`password`, `token`, `code`, …) before logging.

## Security Event Catalogue

Emitted through `logSecurityEvent` (enabled by `SECURITY_LOG_ON`), always with
the request context and a sanitized `reason`:

- `auth_unauthorized` — a 401 that is a signal rather than routine token
  churn. Handler-raised 401s are logged by `ErrorLoggingInterceptor`.
  Guard-raised ones are classified by `JwtGuard` from passport's rejection
  reason and logged by `AllExceptionFilter` (which the interceptor cannot see)
  with `metadata.authFailureReason`:
  - logged: `token_invalid` (malformed, bad signature, wrong audience or
    issuer) and `token_not_active` (`nbf` in the future);
  - **not** logged: `token_missing` (no bearer header — public scans,
    unauthenticated clients) and `token_expired` (normal access-token
    rotation). These still appear as a status-401 warn line and in
    `http_access`, just not in the security log;
  - a revoked session is not logged here either — it already has its own
    `session_revoked_token_used` event.
  A 401 with no classification (a non-JWT guard) is always logged.
- `access_forbidden` — any 403 (wrong audience, missing role, ownership check).
- `rate_limit_hit` — a named limiter rejected the request.
- `session_revoked_token_used` — a validly signed access token whose session
  was revoked (logout-all, ban, password change) was replayed.
- `security_code_invalid` — a wrong login security code (with the running
  attempt count).
- `security_code_locked` — the account hit the security-code lockout.

The security-log call in `AllExceptionFilter` and `ErrorLoggingInterceptor`
is wrapped like the Sentry capture: if the log transport throws, an
error-level `security_event_log_failed` is emitted (with `requestId`) and the
HTTP response is unaffected.

## External services

`external_call_failed` / `external_call_slow` carry `service` + `operation`
and never the payload:

| service     | operations                                              | where                          |
| ----------- | ------------------------------------------------------- | ------------------------------ |
| `minio`     | `presign_put_object`, `put_object`, …                   | `UploadService`                |
| `livekit`   | `create_room`, `delete_room`                            | `LiveKitCallService`           |
| `smtp`      | `send_verification_code`                                | `SmtpMailer`                   |
| `expo_push` | `send`, `get_receipts`                                  | `NotificationPushService`      |
| `redis`     | `connect`                                               | `RedisService`                 |

Persistent failures of these dependencies are also forwarded to error
aggregation via `reportOperationalError` (deduplicated per failure signature
every 60s) so an outage is visible in Sentry even though every call site
handles the error locally.

## Safe Logging Policy

Never log:

- Passwords.
- JWT access tokens.
- Refresh tokens.
- Verification codes.
- Cookies.
- Authorization headers.
- Full request or response bodies.
- Raw upload file contents.
- Secrets or private config values.
- Email addresses (log the domain at most).

Access logs record the route path without query values. Error logs record error
metadata and stack traces, not request payloads. Sentry receives a rebuilt
event: sanitized stack, redacted message, normalized route tags — never the
original message text, breadcrumbs, request data or account identity.

## Typical Debug Flow

1. Ask the client or frontend logs for `x-request-id`.
2. Search app logs for that request ID.
3. Start with the `http_access` event for status and duration.
4. Check for `http_error` with the same request ID.
5. If duration is high, check for `http_slow`.
6. If a write failed due to repeated calls, check for `rate_limit_hit`.
7. If a dependency failed, check for `external_call_failed`.
8. For "what did the user actually do", filter `business_event` by `actorId`.

## Error Aggregation (Sentry)

Unhandled server errors can optionally be forwarded to Sentry for aggregation.
It is **disabled by default** and provider-neutral: the app talks to an
`ErrorAggregationProvider` interface (`src/logging/error-aggregation.service.ts`),
so Datadog/Loki/CloudWatch can be added later behind the same interface without
changing call sites.

### What is sent

- **HTTP 5xx** from anywhere in the pipeline: route handlers
  (`ErrorLoggingInterceptor`), and guards / pipes / middleware / unknown Prisma
  errors (`AllExceptionFilter`, `PrismaExceptionFilter`). The
  `handled-errors` markers make sure one exception is reported once. Expected
  4xx errors — including Prisma unique-constraint races — are never sent.
- **Scheduled jobs**: every `@TrackedCron` failure (thrown or reported via
  `reportHandledJobFailure`'s callers) goes through `reportOperationalError`.
  `@nestjs/schedule` gives `cron` no error handler, so without this the
  exception is only `console.error`ed and never reaches Winston or Sentry.
- **Operational failures** that are handled locally but mean something is
  broken: WebSocket handler failures (chat / realtime gateways), outbox
  dead-letters (push notifications, transfer cards, admin group operations,
  friend chat replay), the sensitive-word filter failing open, the private
  media bucket policy not applying, Expo / SMTP / Redis / LiveKit outages.
- **Sanitized tags only**: `requestId`, `traceId`, `method`, normalized `path`,
  `statusCode`, `component` / `operation` / `kind`, plus `userId` when known.
  Never request bodies, headers, cookies, or tokens — the Safe Logging Policy
  above applies.

### How to enable in production

1. Create a Sentry project (self-hosted or sentry.io) and copy its DSN.
2. Set the following in `.env.production`:

   ```
   LOG_AGGREGATION_PROVIDER=sentry
   SENTRY_DSN=https://<public-key>@<host>/<project-id>
   SENTRY_ENVIRONMENT=production   # optional, defaults to NODE_ENV
   SENTRY_RELEASE=circle-be@1.0.0  # optional, for release health
   SENTRY_TRACES_SAMPLE_RATE=0.05  # optional performance tracing, 0..1
   ```

3. Restart the backend. `Sentry.init()` runs once at boot, inside `setupApp`.

If `LOG_AGGREGATION_PROVIDER` is unset or `none`, or `SENTRY_DSN` is missing, the
provider is a no-op — `@sentry/node` is never loaded and nothing is sent.

### Performance tracing

`SENTRY_TRACES_SAMPLE_RATE` (default 0) turns on transaction sampling. Sampled
transactions are rebuilt from an allowlist before leaving the process
(`sanitizeAutomaticTransaction`): normalized route name, trace / span ids, span
`op` + timings. Span descriptions (SQL text, URLs), request data, breadcrumbs
and user context are dropped. Keep the rate low (a few percent) — the
Prometheus RED metrics already cover server-side latency; tracing is for
"which span inside this route is slow".

> Capture for route handlers happens in `ErrorLoggingInterceptor`, which is
> only registered when `LOG_ON` and `HTTP_LOG_ON` are enabled (the production
> default). The exception filters always run, so guard / pipe failures are
> aggregated even with HTTP logging off.
