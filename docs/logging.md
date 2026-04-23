# Logging Guide

This project uses NestJS logging through `nest-winston`. The current implementation is scoped to development and testing diagnostics.

- Make local API behavior visible without ad-hoc `console.log`.
- Keep unit tests quiet by default.
- Avoid logging secrets or request/response bodies.

Production-only work such as structured JSON logs, persistent audit logs, Sentry/Datadog/Loki/CloudWatch aggregation, and formal retention policies is intentionally deferred.

## Environment Defaults

Development:

- `LOG_ON=true`
- `HTTP_LOG_ON=true`
- `SLOW_REQUEST_MS=1000`
- `BUSINESS_LOG_ON=true`
- `EXTERNAL_LOG_ON=true`
- `RATE_LIMIT_LOG_ON=true`
- Console logs are human-readable.
- Rotated log files are written under root `logs/`.

Test:

- `LOG_ON=false`
- `HTTP_LOG_ON=false`
- `BUSINESS_LOG_ON=false`
- `EXTERNAL_LOG_ON=false`
- `RATE_LIMIT_LOG_ON=false`
- Test output is quiet by default.
- E2E runs may explicitly enable error and slow request logs.

## Request Correlation

Every HTTP response includes `x-request-id`.

If a client sends a safe `x-request-id`, the backend reuses it. Otherwise the backend generates a UUID. Use this ID to correlate:

- `http_access`
- `http_slow`
- `http_error`
- `rate_limit_hit`
- `business_event`
- `external_call_failed`

## Event Types

Current events:

- `http_access`: one event for each completed request.
- `http_slow`: warning event when request duration is above `SLOW_REQUEST_MS`.
- `http_error`: error event for thrown HTTP or server errors.
- `rate_limit_hit`: explicit limiter hit with limiter name.
- `business_event`: currently used for auth and selected friend actions.
- `external_call_failed`: currently used for OpenIM and MinIO presign failures.

Deferred production events:

- `audit_event`
- `security_event`
- `external_call_slow`
- `db_query_slow`

## Safe Logging Policy

Never log:

- Passwords.
- JWT access tokens.
- Refresh tokens.
- OpenIM tokens.
- Verification codes.
- Cookies.
- Authorization headers.
- Full request or response bodies.
- Raw upload file contents.
- Secrets or private config values.

Access logs record the route path without query values. Error logs record error metadata and stack traces, not request payloads.

## Typical Debug Flow

1. Ask the client or frontend logs for `x-request-id`.
2. Search app logs for that request ID.
3. Start with the `http_access` event for status and duration.
4. Check for `http_error` with the same request ID.
5. If duration is high, check for `http_slow`.
6. If a write failed due to repeated calls, check for `rate_limit_hit`.
7. If OpenIM or MinIO failed, check for `external_call_failed`.
