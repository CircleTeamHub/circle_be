# Phase D — Logging Foundation + Logs Module Review

Branch: `codex/dev-test-logging` → `main` | Scope: `src/logging/*`, `src/logs/*`, `src/interceptors/error-logging.interceptor.ts`, `src/setup.ts`, `src/main.ts`, `src/app.module.ts`, `docs/logging.md`

**Important scope note:** The task brief described a "DB-backed logs module" with `GET /logs` returning the logs table. That does **not** exist on this branch. `src/logs/logs.entity.ts` explicitly states *"TypeORM removed. Database persistence for logs is out of scope for this round."* `LogsService` is an empty stub. `LogsController` is a leftover scaffold (`getTest`/`postTest`) unrelated to the winston logging feature. The actual logging feature writes to console + rotating files only — no DB persistence, no logs-query endpoint, no unbounded `findMany`. Several brief-anticipated HIGH risks therefore do not apply.

---

## 1. TL;DR Table

| # | Severity | File:Line | Description |
|---|----------|-----------|-------------|
| 1 | MEDIUM | logs.controller.ts:53-63 | `POST /logs` echoes `@Body() dto` straight back and `console.log`s it; `LogsDto.msg/id/name` are arbitrary attacker-supplied strings. Stub endpoint with no real purpose, reachable by any Admin. Log-injection + dead-code risk. |
| 2 | MEDIUM | request-logger.middleware.ts:62-92 | `http_access` is logged on `res.on('finish')`. With file transports enabled this is a synchronous-ish disk write per request on the hot path; under load winston file rotation/zip can back up. Acceptable for dev, but `httpLogOn` defaults to ON in production. |
| 3 | LOW | logs.controller.ts:58-61 | `console.log` with emoji debug banner left in committed code. |
| 4 | LOW | winston-options.ts:91-96 | The "error" daily-rotate transport is created at `level: 'warn'`, so the file named `error-*.log` actually contains warnings too. Misleading filename. |
| 5 | LOW | winston-options.ts:39-43 | `datePattern: 'YYYY-MM-DD-HH'` (hourly files) combined with `maxFiles: '14d'` retention — 24 files/day; fine, but `application` and `error` both write hourly which multiplies file count. Naming/retention mismatch worth confirming. |
| 6 | LOW | request-context.ts:38-43 / middleware:64-65 | `setRequestUserId` mutates the live context object in place (violates the project immutability rule). Functionally correct for ALS, but inconsistent with house style. |
| 7 | LOW | logs.service.spec.ts / logs.controller.spec.ts | Both spec files are fully commented out — zero real coverage for the `logs` module. |
| 8 | LOW | logs.entity.ts / logs.service.ts / logs.module.ts | Dead scaffold module shipped: `LogsService` empty, `LogsController` returns `'test'`. `LogsModule` is not even imported in `app.module.ts` (see Verified OK). Dead code. |

No HIGH findings. No tokens/passwords/JWTs found logged verbatim. No auth-bypassed logs endpoint. No unbounded query.

---

## 2. Per-File Walkthrough

### src/logging/request-context.ts
- AsyncLocalStorage usage is correct: a fresh `RequestContext` object is created per request in the middleware and `requestContextStorage.run(...)` scopes it. No cross-request leakage — each request gets its own store; `getStore()` returns `undefined` outside a request (verified by spec).
- `resolveRequestId` (L17-25) correctly validates an incoming `x-request-id` against `SAFE_REQUEST_ID` (`/^[A-Za-z0-9._:-]{1,128}$/`) before reuse, and falls back to `randomUUID()`. This prevents header-based log injection / CRLF via the request id. Good.
- L38-43 `setRequestUserId` mutates the context in place — see finding #6 (LOW, style only; ALS stores hold references so in-place mutation is the normal pattern, but the repo's coding-style rule forbids mutation).

### src/logging/request-logger.middleware.ts
- `readPath` (L14-17) strips the query string (`split('?')[0]`) — query values never reach logs. Good; this is the documented "route path without query values" guarantee and the spec confirms `secret=value` does not appear.
- Request **body and headers are never logged** — only `method`, `path`, `statusCode`, `durationMs`, `ip`, `userAgent`, `contentLength`, `userId`. No Authorization header, no cookies, no JWT. Spec explicitly asserts `password`/`authorization` absent. PII surface is limited to `ip` + `userAgent` + `userId`, which is standard access-log content. OK.
- `readIp` trusts `x-forwarded-for` (L19-24) unconditionally — a client can spoof the logged IP. LOW: it is only a log field, not used for auth/rate-limit decisions, so impact is log-poisoning of the `ip` field at most. Worth a note if IP is ever used for security correlation.
- Finding #2 (MEDIUM): the `finish` handler calls `logger.log`/`logger.warn`, which with `loggingConfig.logOn` fans out to two `DailyRotateFile` transports. One log line per request hitting disk on the response path. winston file writes are async but the rotation/zip step can stall; in dev this is fine, but `httpLogOn` defaults to `true` outside test (`logging.config.ts:55-56`). No async queue / sampling. Recommend confirming production intent or gating file transports off in prod.
- `userId` is read at `finish` time via `readUserId` (L33-36, `req.user?.userId || req.user?.id`) — correct, because auth guards populate `req.user` after the middleware runs.

### src/logging/winston-options.ts
- `createContextFormat` (L13-28) merges ALS context (`requestId/traceId/userId/method/path`) into every log line. Only identifiers — no secrets. OK.
- Finding #4 (LOW): `createDailyRotateTransport('warn', 'error', …)` — the file is named `error` but level `warn` means warnings land there too. Cosmetic.
- File format uses `winston.format.simple()` — no JSON, no explicit redaction transport. Acceptable because no logger in scope writes raw bodies; the redaction burden is correctly pushed to each event logger instead. Note there is **no global scrub format** — safety depends entirely on each call site being disciplined. That holds today but is fragile for future loggers.

### src/logging/logging.config.ts
- Pure config parsing, `readBoolean`/`readPositiveInteger` are defensive and well-bounded. Test env defaults everything off. OK. No issues.

### src/logging/business-event.logger.ts
- `SENSITIVE_KEYS` set (L17-26) drops `password/passwordHash/token/accessToken/refreshToken/authorization/secret/code` from `metadata` (case-insensitive). Good.
- Limitation: `sanitizeMetadata` is **shallow** — a nested object like `metadata: { user: { password: '…' } }` would not be scrubbed. LOW given current callers pass flat metadata, but document/enforce flat metadata.
- Logs only `actorId/targetId/entityType/entityId` + sanitized metadata — no bodies. OK.

### src/logging/security-event.logger.ts
- `sanitizeText` (L16-30) regex-redacts `authorization=…`, `cookie=…`, `password|token|secret=…` patterns from free-text `reason`, and `sanitizeMetadata` redacts by key pattern and recursively `sanitizeText`s string values. Reasonable defense.
- Limitation: redaction only matches the `key=value` shape. A bare bearer token in a message (`"Bearer eyJ…"` with no `authorization=` prefix) would pass through. The `ErrorLoggingInterceptor` feeds `errorObject.message` into `reason` for 401/403 — if an auth error message ever embedded a raw token it would not be caught. LOW: Nest/passport 401 messages are generic ("Unauthorized"), so no concrete leak today.

### src/logging/performance-event.logger.ts & external-service.logger.ts
- Both log only `service/operation/durationMs/result` + error **name** and a redacted error **message** (`getSafeErrorMessage` strips `token|secret|password|authorization=…`). No stack of external payloads, no request bodies. OK.

### src/logging/rate-limit-logger.ts
- Logs `limiterName/method/path/statusCode/userId/ip`. `readPath` strips query. Delegates to `logSecurityEvent`. No body/header logging. OK.
- `req.ip` used directly here too (same spoofable-IP note as middleware, LOW).

### src/interceptors/error-logging.interceptor.ts
- Logs `http_error` with `errorName/message/stack` + ALS context. The **stack trace is logged** (L39, L41) — stacks can contain file paths and occasionally interpolated values, but not request bodies here. Standard practice. OK.
- `message: errorObject?.message ?? String(error)` (L38) — error messages are application-controlled; low leak risk. For 401/403 it forwards `reason` to `logSecurityEvent` which re-sanitizes. OK.
- `createLoggingConfig()` is called with no args at construction (L16) → reads `process.env` directly rather than the validated `ConfigService`. Minor inconsistency with `setup.ts` which passes `getServerConfig()`. LOW.

### src/logs/* (controller / service / entity / module)
- **Not the winston logging feature.** Leftover CRUD scaffold. `logs.entity.ts` confirms DB persistence was removed and is out of scope.
- `LogsController` (`@Controller('logs')`) **is** correctly guarded: `@UseGuards(JwtGuard, AdminGuard, CaslGuard)` at class level + `@CheckPolices(... Action.Read, Logs)` + per-route `@Can`. `AdminGuard` requires `request.user?.role === Role.Admin`, `CaslGuard` returns `false` when `req.user` is absent. So even though the endpoints are useless stubs, they are not an open data-exposure hole.
- Finding #1 (MEDIUM): `postTest` echoes the request body verbatim and `console.log`s it — log injection + pointless surface. Finding #3/#7/#8: console.log, empty specs, dead module.
- **`LogsModule` is never imported into `app.module.ts`** — so `LogsController` is most likely not even routed (verify). If unrouted, findings #1/#3 drop toward LOW. Either way the module should be deleted, not merged.

### src/setup.ts (diff vs main)
- Cleanly refactors limiters into `*Options` + `createLimiter` factory that attaches `createRateLimitHandler`. Logger is only wired when `loggingConfig.logOn`. `ErrorLoggingInterceptor` + request-logger middleware registered only when `logger && httpLogOn`. Correct ordering: request-logger middleware runs before interceptors so ALS context is available. OK.
- New per-route limiter names (`auth_register`, `circle_invitation_write`, etc.) — good observability granularity.

### src/main.ts / src/app.module.ts (diff vs main)
- `main.ts`: only adds `RealtimeGateway.attach(...)` — unrelated to logging, out of scope, no logging concern.
- `app.module.ts`: only adds feature modules (Membership/Mall/Realtime/etc.) — none of them is `LogsModule`. No logging wiring here; `WinstonModule` is configured inside `LogsModule` (unused) and presumably elsewhere — confirm winston provider (`WINSTON_MODULE_NEST_PROVIDER`) is actually available to `app.get(...)` in `setup.ts`, since `LogsModule` (which declares `WinstonModule.forRootAsync`) is not imported. **Potential runtime gap:** if no other module registers `WinstonModule`, `app.get(WINSTON_MODULE_NEST_PROVIDER)` in `setup.ts` will throw when `LOG_ON=true`. Worth verifying before merge (could be MEDIUM/HIGH if it crashes boot in production where `LOG_ON=true`).

### docs/logging.md
- Claims match code: query values stripped, bodies not logged, `x-request-id` correlation, event-type list. The "Safe Logging Policy" never-log list is consistent with the loggers reviewed. Doc honestly flags DB/aggregation as deferred. No misleading claims.

---

## 3. Verified OK

- No request bodies, headers, Authorization tokens, passwords, JWTs, or refresh tokens are logged verbatim by any logger in `src/logging/*` or the interceptor.
- Query strings are stripped from all logged paths (`request-logger.middleware`, `rate-limit-logger`).
- `business-event` and `security-event` loggers perform key-based + text redaction of `password/token/secret/authorization/cookie`.
- AsyncLocalStorage context is correctly per-request scoped; no cross-request leakage; `getStore()` undefined outside a request.
- Incoming `x-request-id` is regex-validated before reuse — no header-driven log injection via request id.
- `LogsController` routes are guarded by `JwtGuard + AdminGuard + CaslGuard` — no unauthenticated/non-admin access path.
- No DB-backed logs query / no unbounded `findMany` exists on this branch (DB persistence explicitly out of scope).
- Test environment defaults all logging off; env vars validated via Joi in `env.validation.ts`.
- Logger wiring in `setup.ts` is conditional and ordered correctly (middleware → ALS → interceptors).

---

## 4. Phase Verdict

**Merge-ready: YES, with caveats. No blocking (HIGH) issues in the logging feature itself.**

The winston logging foundation is sound: redaction is applied at every event logger, no secrets/bodies/tokens are logged, ALS context is correct, and `x-request-id` is validated. The brief's anticipated HIGH risks (unauthenticated logs endpoint, verbatim token logging, unbounded query) **do not materialize** — the DB-backed logs module does not exist on this branch.

Recommended before merge (non-blocking but should be addressed):
1. **Verify the winston provider resolves.** `LogsModule` (the only module declaring `WinstonModule.forRootAsync`) is not imported in `app.module.ts`. Confirm `app.get(WINSTON_MODULE_NEST_PROVIDER)` in `setup.ts` does not throw at boot when `LOG_ON=true` — if it does, this becomes a HIGH (production boot crash).
2. **Delete the dead `src/logs/` scaffold** (controller/service/entity + commented-out specs) or finish it — shipping `getTest()`/`console.log(dto)` and empty test files is debt (findings #1, #3, #7, #8).
3. Confirm production intent for per-request file logging on the hot path (finding #2); consider gating file transports in prod or sampling `http_access`.
4. Rename the `error` rotate transport or raise it to `level: 'error'` (finding #4).

Logging-feature code quality is good; the only real cleanup is the unrelated `logs/` scaffold that rode along in the branch.
