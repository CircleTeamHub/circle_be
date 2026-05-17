# Complete Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete logging system for development, testing, and production that supports debugging, request tracing, auditability, security investigation, performance analysis, and production aggregation without leaking sensitive data.

**Architecture:** Keep `nest-winston` as the app logger, add request context with `AsyncLocalStorage`, add HTTP access logging middleware, add error logging through a global interceptor/filter path, add explicit business/audit/security/performance logger services, and make production output structured JSON. Audit events are persisted separately from transient app logs.

**Tech Stack:** NestJS, Express middleware, Winston, `winston-daily-rotate-file`, Prisma, Jest, Node `AsyncLocalStorage`, optional Sentry integration for production error aggregation.

---

## Scope And Logging Policy

This plan includes all required development/test logs and production logs:

- HTTP access logs for every request.
- Error logs with request context and stack traces.
- Slow request logs.
- Business event logs.
- External service logs for OpenIM, MinIO, database, and future third-party calls.
- Rate limit logs.
- Structured JSON logs for production.
- Request ID / trace ID propagation.
- Audit logs for sensitive business and administrative actions.
- Security logs for authentication, authorization, JWT, and abuse signals.
- Performance logs for slow HTTP, slow database, and slow external calls.
- Error aggregation integration.
- Log retention policy.

Sensitive data must never be logged:

- Passwords, JWT access tokens, refresh tokens, OpenIM tokens, verification codes, secrets, cookies, or authorization headers.
- Full request bodies or response bodies.
- Full upload file contents.
- Private user profile fields unless explicitly whitelisted for audit.
- Raw query values by default.

Default payload policy:

- Access logs record route/path shape, not full body.
- Error logs record sanitized error metadata and stack, not body.
- Audit logs record actor, target, action, result, and sanitized metadata.
- Development may later add a whitelist-only body summary, but this implementation must not log body by default.

## Public Interfaces And Configuration

Add environment variables:

- `HTTP_LOG_ON`: enables HTTP access, slow request, and HTTP error logging.
- `SLOW_REQUEST_MS`: threshold for `http_slow` warning logs. Default `1000`.
- `LOG_FORMAT`: optional override, `pretty` or `json`. Default: `pretty` outside production, `json` in production.
- `AUDIT_LOG_ON`: enables audit log persistence. Default `true` outside test.
- `SECURITY_LOG_ON`: enables security event logs. Default `true` outside test.
- `PERFORMANCE_LOG_ON`: enables slow DB and external service performance logs. Default `true` outside test.
- `LOG_AGGREGATION_PROVIDER`: `none` or `sentry`. Default `none`.
- `SENTRY_DSN`: required only when `LOG_AGGREGATION_PROVIDER=sentry`.
- `LOG_RETENTION_DAYS`: app log retention. Default `14`.
- `AUDIT_LOG_RETENTION_DAYS`: audit log retention. Default `365`.

Environment defaults:

- Development: `LOG_ON=true`, `HTTP_LOG_ON=true`, pretty console logs, file logs enabled, slow threshold `1000ms`.
- Test: `LOG_ON=false`, `HTTP_LOG_ON=false`, `AUDIT_LOG_ON=false`, quiet by default; E2E may override to log only errors and slow requests.
- Production: `LOG_ON=true`, `HTTP_LOG_ON=true`, `AUDIT_LOG_ON=true`, `SECURITY_LOG_ON=true`, `PERFORMANCE_LOG_ON=true`, JSON logs, rotated files, optional aggregation.

Every HTTP response gets an `x-request-id` header. Incoming `x-request-id` is reused only if it is a safe string with max length 128; otherwise generate `crypto.randomUUID()`.

## Implementation Tasks

### Task 1: Centralize Log Configuration

**Files:**
- Modify: `src/enum/config.enum.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `.env.example`, `.env.development`, `.env.test`, `.env.production`
- Create: `src/logging/logging.config.ts`
- Test: `src/logging/logging.config.spec.ts`

- [ ] **Step 1: Write tests for default config by environment**
- [ ] **Step 2: Add Joi validation for all logging env vars**
- [ ] **Step 3: Add typed helpers for booleans, numbers, and environment defaults**
- [ ] **Step 4: Verify test env is quiet unless explicitly overridden**
- [ ] **Step 5: Run `npm test -- logging.config.spec.ts env.validation.spec.ts`**

Acceptance:

- Invalid numeric thresholds fail validation.
- Test env defaults do not print noisy logs.
- Production defaults to JSON logs and enabled core logging.

### Task 2: Build Request Context And Trace ID Propagation

**Files:**
- Create: `src/logging/request-context.ts`
- Create: `src/logging/request-context.spec.ts`

- [ ] **Step 1: Define `RequestContext` with `requestId`, `traceId`, `method`, `path`, `ip`, `userAgent`, and optional `userId`**
- [ ] **Step 2: Implement `AsyncLocalStorage<RequestContext>` helpers**
- [ ] **Step 3: Implement safe inbound request ID validation**
- [ ] **Step 4: Add helper to update `userId` after JWT auth populates `req.user`**
- [ ] **Step 5: Test context survives async boundaries**
- [ ] **Step 6: Run `npm test -- request-context.spec.ts`**

Acceptance:

- Any service can read the current request ID without passing it through method parameters.
- Context lookup safely returns `undefined` outside HTTP requests.

### Task 3: Refactor Winston Setup For Pretty Development And JSON Production

**Files:**
- Modify: `src/logs/logs.module.ts`
- Create: `src/logging/winston-options.ts`
- Create: `src/logging/winston-options.spec.ts`

- [ ] **Step 1: Extract Winston option creation into a pure function**
- [ ] **Step 2: Keep readable Nest-like console formatting for development**
- [ ] **Step 3: Use JSON format in production with fixed fields**
- [ ] **Step 4: Enrich all log entries with request context when available**
- [ ] **Step 5: Keep daily rotate files and make retention configurable**
- [ ] **Step 6: Run `npm test -- winston-options.spec.ts`**

Production JSON fields:

- `timestamp`, `level`, `context`, `event`, `message`
- `requestId`, `traceId`, `userId`
- `method`, `path`, `statusCode`, `durationMs`
- `errorName`, `stack`

Acceptance:

- Production logs are valid JSON lines.
- Development logs remain readable in terminal.
- File rotation still works and defaults to 14 days.

### Task 4: Add HTTP Access And Slow Request Logs

**Files:**
- Create: `src/logging/request-logger.middleware.ts`
- Create: `src/logging/request-logger.middleware.spec.ts`
- Modify: `src/setup.ts`
- Modify: `src/setup.spec.ts`

- [ ] **Step 1: Implement Express middleware that creates request context**
- [ ] **Step 2: Set `x-request-id` response header**
- [ ] **Step 3: Log one `http_access` event on `res.finish`**
- [ ] **Step 4: Log `http_slow` warning when duration is above `SLOW_REQUEST_MS`**
- [ ] **Step 5: Read `req.user?.userId || req.user?.id` at finish time**
- [ ] **Step 6: Register middleware before helmet and rate limiters**
- [ ] **Step 7: Run `npm test -- request-logger.middleware.spec.ts setup.spec.ts`**

Access log fields:

- `event=http_access`
- `method`, `path`, `statusCode`, `durationMs`
- `requestId`, `traceId`, `userId`
- `ip`, `userAgent`, `contentLength`

Acceptance:

- Every request logs exactly one access event when enabled.
- 404 and 429 responses are logged.
- Body, cookies, authorization, and tokens are not logged.

### Task 5: Add Global Error Logging

**Files:**
- Create: `src/interceptors/error-logging.interceptor.ts`
- Create: `src/interceptors/error-logging.interceptor.spec.ts`
- Modify: `src/setup.ts`
- Consider: `src/filters/prisma-exception.filter.ts`

- [ ] **Step 1: Implement interceptor that logs and rethrows errors**
- [ ] **Step 2: Log `http_error` with request context, status, error name, message, and stack**
- [ ] **Step 3: Ensure Prisma errors still return existing response shape**
- [ ] **Step 4: Avoid duplicate error logs for the same thrown error**
- [ ] **Step 5: Run `npm test -- error-logging.interceptor.spec.ts setup.spec.ts`**

Acceptance:

- Client response contract does not change.
- Errors include stack traces in logs.
- Error logs include request ID and path.

### Task 6: Add Rate Limit Logs

**Files:**
- Create: `src/logging/rate-limit-logger.ts`
- Create: `src/logging/rate-limit-logger.spec.ts`
- Modify: `src/setup.ts`

- [ ] **Step 1: Create a shared `rateLimitHandler(limiterName)` helper**
- [ ] **Step 2: Attach the handler to global and route-specific `express-rate-limit` configs**
- [ ] **Step 3: Log `rate_limit_hit` as security warning**
- [ ] **Step 4: Include `limiterName`, `path`, `ip`, `userId`, `requestId`, and remaining/reset metadata when available**
- [ ] **Step 5: Preserve existing 429 response body**
- [ ] **Step 6: Run `npm test -- rate-limit-logger.spec.ts setup.spec.ts`**

Limiter names:

- `global`
- `auth_login`
- `auth_register`
- `auth_change_password`
- `auth_refresh`
- `friend_requests`
- `coin_gift`
- `note_write`
- `friend_report`
- `circle_write`
- `circle_invitation_write`
- `circle_plaza_write`
- `trace_write`

Acceptance:

- Any 429 has both access log and explicit `rate_limit_hit` log.
- Existing rate limit behavior remains unchanged.

### Task 7: Add Business Event Logger

**Files:**
- Create: `src/logging/business-event.service.ts`
- Create: `src/logging/business-event.service.spec.ts`
- Modify targeted services only where events already happen.

- [ ] **Step 1: Implement `BusinessEventService.log(eventName, payload)`**
- [ ] **Step 2: Require `actorId`, `result`, and sanitized metadata for each event**
- [ ] **Step 3: Add events for auth login success/failure, logout, logout all, register**
- [ ] **Step 4: Add events for friend request sent, accepted, rejected, canceled, block created**
- [ ] **Step 5: Add events for circle join/leave/invite/application/admin approval**
- [ ] **Step 6: Add events for trace post create/delete/like/comment/delete comment**
- [ ] **Step 7: Add events for coin recharge/gift and membership upgrade**
- [ ] **Step 8: Run targeted service tests for touched modules**

Business event fields:

- `event=business_event`
- `businessEvent`, `actorId`, `targetId`, `entityType`, `entityId`
- `result=success|failure`
- `requestId`, `traceId`
- `metadata` with sanitized non-sensitive fields only

Acceptance:

- Key user-visible state changes are logged.
- Failed login logs do not reveal whether account ID or password was wrong beyond existing behavior.
- No passwords, tokens, messages, or private profile details are logged.

### Task 8: Add Audit Log Persistence

**Files:**
- Modify: `prisma/schema.prisma`
- Create: Prisma migration for `AuditLog`
- Create: `src/logging/audit-log.service.ts`
- Create: `src/logging/audit-log.service.spec.ts`
- Modify modules that perform auditable actions.

- [ ] **Step 1: Add `AuditLog` model**
- [ ] **Step 2: Generate migration**
- [ ] **Step 3: Implement append-only audit writer**
- [ ] **Step 4: Never update or delete audit rows in normal app flow**
- [ ] **Step 5: Add audit writes for login/logout/change password, user status changes, block/unblock, delete content, coin changes, membership changes, and admin approval**
- [ ] **Step 6: Add tests that audit writes are called after successful actions**
- [ ] **Step 7: Run `npm run prisma:generate` and targeted tests**

Suggested `AuditLog` fields:

- `id`, `createdAt`
- `actorId`, `actorRole`
- `action`
- `targetType`, `targetId`
- `result`
- `requestId`, `traceId`
- `ip`, `userAgent`
- `metadata Json`

Acceptance:

- Audit logs are queryable independently from app log files.
- Audit metadata is sanitized.
- Failed sensitive actions may write audit rows when useful, but never include secrets.

### Task 9: Add Security Logs

**Files:**
- Create: `src/logging/security-event.service.ts`
- Create: `src/logging/security-event.service.spec.ts`
- Modify: auth strategy/guards/services where security decisions occur.

- [ ] **Step 1: Implement `SecurityEventService.warn(eventName, payload)`**
- [ ] **Step 2: Log login failure, repeated auth failure, JWT invalid/expired, forbidden role/CASL denial, rate limit hit, and suspicious request ID values**
- [ ] **Step 3: Include `requestId`, `traceId`, `ip`, `userId` if known, `path`, and `reasonCode`**
- [ ] **Step 4: Do not log token values or raw credentials**
- [ ] **Step 5: Add tests for guards/strategy paths where practical**

Security event names:

- `auth_login_failed`
- `jwt_invalid`
- `jwt_expired`
- `authorization_denied`
- `rate_limit_hit`
- `suspicious_request_id`

Acceptance:

- 401/403 causes are visible in logs without exposing secrets.
- Security logs can be filtered by `event=security_event`.

### Task 10: Add External Service Logs And Timing

**Files:**
- Create: `src/logging/external-call-logger.ts`
- Create: `src/logging/external-call-logger.spec.ts`
- Modify: `src/openim/openim.service.ts`
- Modify: `src/upload/upload.service.ts`
- Modify: `src/prisma/prisma.service.ts`

- [ ] **Step 1: Implement helper to wrap external async calls and measure duration**
- [ ] **Step 2: Log `external_call` on success at debug/info level for development only if noisy**
- [ ] **Step 3: Log `external_call_failed` on failure with service name, operation, duration, requestId, and sanitized error**
- [ ] **Step 4: Log `external_call_slow` when above threshold**
- [ ] **Step 5: Apply to OpenIM admin/token/register calls**
- [ ] **Step 6: Apply to MinIO/S3 presign and bucket checks**
- [ ] **Step 7: Keep database connect success/warn/error logs and add request context where available**

Acceptance:

- External failures include enough metadata to identify the failing provider and operation.
- No external secrets, tokens, URLs with sensitive query params, or signed URLs are logged.

### Task 11: Add Performance Logs For DB And App Hot Paths

**Files:**
- Modify: `src/prisma/prisma.service.ts`
- Create: `src/logging/performance-logger.service.ts`
- Create: `src/logging/performance-logger.service.spec.ts`

- [ ] **Step 1: Add configurable thresholds for `SLOW_DB_QUERY_MS` and `SLOW_EXTERNAL_CALL_MS`**
- [ ] **Step 2: Use Prisma query event logging if supported by the current Prisma client setup**
- [ ] **Step 3: If Prisma query event logging is not available, wrap selected high-risk service methods instead**
- [ ] **Step 4: Log `db_query_slow` with model/action/duration when available, never raw parameters**
- [ ] **Step 5: Add tests for performance logger formatting and redaction**

Acceptance:

- Slow HTTP, slow DB, and slow external calls are distinguishable by event name.
- Raw SQL parameters and user data are not logged.

### Task 12: Add Error Aggregation

**Files:**
- Create: `src/logging/error-aggregation.service.ts`
- Create: `src/logging/error-aggregation.service.spec.ts`
- Modify: `src/interceptors/error-logging.interceptor.ts`
- Modify: app bootstrap if provider initialization is needed.

- [ ] **Step 1: Implement provider interface with `none` and `sentry` implementations**
- [ ] **Step 2: Initialize Sentry only when `LOG_AGGREGATION_PROVIDER=sentry` and `SENTRY_DSN` is present**
- [ ] **Step 3: Send unhandled 5xx errors to aggregation with request ID and sanitized tags**
- [ ] **Step 4: Do not send expected 4xx validation/auth errors by default**
- [ ] **Step 5: Add tests that `none` provider is a no-op and Sentry provider is gated by env**

Acceptance:

- Production can aggregate unexpected server errors without relying only on files.
- Aggregation payloads do not include request body, authorization headers, or tokens.

### Task 13: Add Retention And Operations Documentation

**Files:**
- Create: `docs/logging.md`
- Modify: `README.md` only to link to `docs/logging.md`.

- [ ] **Step 1: Document all event names and required fields**
- [ ] **Step 2: Document environment-specific defaults**
- [ ] **Step 3: Document redaction policy**
- [ ] **Step 4: Document how to debug by `x-request-id`**
- [ ] **Step 5: Document retention policy: app logs 14 days, error logs 14 days, audit logs 365 days by default**
- [ ] **Step 6: Document how to enable Sentry in production**

Acceptance:

- A developer can answer "where is request X failing?" from the docs.
- A production operator can answer "which logs are retained and where?" from the docs.

## Test Plan

Run targeted tests after each task:

- `npm test -- logging.config.spec.ts`
- `npm test -- request-context.spec.ts`
- `npm test -- winston-options.spec.ts`
- `npm test -- request-logger.middleware.spec.ts`
- `npm test -- error-logging.interceptor.spec.ts`
- `npm test -- rate-limit-logger.spec.ts`
- `npm test -- business-event.service.spec.ts`
- `npm test -- audit-log.service.spec.ts`
- `npm test -- security-event.service.spec.ts`
- `npm test -- external-call-logger.spec.ts`
- `npm test -- performance-logger.service.spec.ts`
- `npm test -- error-aggregation.service.spec.ts`

Run broader checks before completion:

- `npm test`
- `npm run build`
- `npm run start:dev`, then manually call representative endpoints and inspect logs.

Manual scenarios:

- Successful `GET` request logs one access event.
- 404 logs access event with `statusCode=404`.
- Validation failure logs access event and no body.
- Unhandled 500 logs access event and `http_error`.
- A slow request logs `http_slow`.
- A rate-limited route logs both `http_access` with `429` and `rate_limit_hit`.
- Login success/failure logs business/security events without credentials.
- Coin gift writes business event and audit log.
- Content deletion writes business event and audit log.
- OpenIM unavailable logs external failure without secret values.
- Production mode emits valid JSON logs.
- Test mode remains quiet by default.

## Rollout Plan

- Phase 1: Implement request context, Winston format, access logs, slow request logs, and error logs.
- Phase 2: Add rate limit, security, external service, and performance logs.
- Phase 3: Add business events and audit log persistence.
- Phase 4: Add error aggregation and operations documentation.

Each phase must be independently shippable and tested.

## Acceptance Criteria

- Development shows useful per-request logs without adding manual console statements.
- Test output remains quiet unless a test explicitly enables logging.
- Production logs are structured JSON with stable fields.
- Every request has a request ID and returns `x-request-id`.
- Errors, slow requests, rate limits, security denials, business actions, audit actions, external failures, and performance events are searchable by `event`.
- No sensitive data is logged in unit tests or manual checks.
- Audit logs are persisted and retained separately from transient app logs.
- Error aggregation is optional and disabled unless explicitly configured.

## Assumptions

- The first production aggregation provider will be Sentry because it is focused on error aggregation; Datadog, Loki, or CloudWatch can be added later through the same provider interface.
- Audit log persistence uses Prisma and the existing database.
- Existing response body contracts should not change.
- Existing business logic should not be refactored except where needed to insert focused logging calls.
- Exact Prisma query logging support must be verified during implementation against the installed Prisma version; if unavailable, use explicit service-level timing wrappers.
