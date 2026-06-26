# Logging Guide

This project uses NestJS logging through `nest-winston`. The current implementation is scoped to development and testing diagnostics.

- Make local API behavior visible without ad-hoc `console.log`.
- Keep unit tests quiet by default.
- Avoid logging secrets or request/response bodies.

Production-only work such as structured JSON logs, persistent audit logs, Datadog/Loki/CloudWatch aggregation, and formal retention policies is intentionally deferred. Optional **Sentry** error aggregation is available — see [Error Aggregation (Sentry)](#error-aggregation-sentry).

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

If a client sends a safe `x-request-id`, the backend reuses it. Otherwise the backend generates a UUID. Use this ID to correlate:

- `http_access`
- `http_slow`
- `http_error`
- `rate_limit_hit`
- `business_event`
- `external_call_failed`
- `security_event`
- `external_call_slow`

## Event Types

Current events:

- `http_access`: one event for each completed request.
- `http_slow`: warning event when request duration is above `SLOW_REQUEST_MS`.
- `http_error`: error event for thrown HTTP or server errors.
- `rate_limit_hit`: explicit limiter hit with limiter name.
- `business_event`: currently used for auth and selected friend actions.
- `external_call_failed`: currently used for OpenIM and MinIO presign failures.
- `security_event`: currently used for 401, 403, and rate limit hits.
- `external_call_slow`: warning event for slow OpenIM or MinIO calls.

Deferred production events:

- `audit_event`
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

## Error Aggregation (Sentry)

Unhandled server errors can optionally be forwarded to Sentry for aggregation.
It is **disabled by default** and provider-neutral: the app talks to an
`ErrorAggregationProvider` interface (`src/logging/error-aggregation.service.ts`),
so Datadog/Loki/CloudWatch can be added later behind the same interface without
changing call sites.

### What is sent

- Only **unhandled 5xx** errors (the same path that logs `http_error`). Expected
  4xx validation/auth errors are never sent.
- **Sanitized tags only**: `requestId`, `traceId`, `method`, `path`, `statusCode`,
  plus `userId` when known. Never request bodies, headers, cookies, or tokens —
  the same Safe Logging Policy above applies.

### How to enable in production

1. Create a Sentry project (self-hosted or sentry.io) and copy its DSN.
2. Set the following in `.env.production`:

   ```
   LOG_AGGREGATION_PROVIDER=sentry
   SENTRY_DSN=https://<public-key>@<host>/<project-id>
   SENTRY_ENVIRONMENT=production   # optional, defaults to NODE_ENV
   SENTRY_RELEASE=circle-be@1.0.0  # optional, for release health
   ```

3. Restart the backend. `Sentry.init()` runs once at boot, inside `setupApp`.

If `LOG_AGGREGATION_PROVIDER` is unset or `none`, or `SENTRY_DSN` is missing, the
provider is a no-op — `@sentry/node` is never loaded and nothing is sent.

> Capture happens in `ErrorLoggingInterceptor`, which is only registered when
> `LOG_ON` and `HTTP_LOG_ON` are enabled (the production default). With HTTP
> logging off, errors are still logged by the global filter but not aggregated.
