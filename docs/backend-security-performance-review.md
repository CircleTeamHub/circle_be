# Backend Security & Performance Review — `circle_be` (NestJS + Prisma)

> **Status:** Point-in-time audit — **2026-07-02**. Key P1/P2 findings re-verified
> still-open on **2026-07-04** (F-01, F-04, F-05, F-10 confirmed present; others
> not re-checked). Line numbers are from the audit snapshot and may have drifted.
> **Companion doc:** the client-side plan lives in the `circle-im` repo at
> `docs/client-security-remediation-plan.md` (findings **C-01…C-08**). Backend
> findings here are **F-01…F-12**; a few cross-link (F-04 ↔ C-01, coin-gift
> idempotency ↔ C-04).

## Remediation status (updated 2026-07-16)

| Finding | Sev | Status |
|---|---|---|
| F-01 search privacy | P1 | ✅ Fixed — PR #46 |
| F-02 stateless access token | P1 | ✅ Fixed — Redis session revocation, fail-open |
| F-03 public chat/notes media | P1 | ⛔ Won't-fix — **accepted 2026-07-15**: media kept public (UUID keys, "have-link-can-view" is acceptable per product) |
| F-04 trust proxy | P1 | ✅ Fixed (landed before this pass) |
| F-05 dev email bypass | P2 | ✅ Fixed — PR #46 (explicit opt-in) |
| F-06 conflict field leak | P2 | ✅ Fixed — PR #46 |
| F-08 upload size cap | P2 | ✅ Fixed (sizeBytes @Max + ContentLength binding) |
| F-09 refresh-token pruning | P2 | ✅ Fixed — daily cleanup cron |
| F-10 logs console.log | P3 | ✅ Fixed — PR #46 |
| F-07 register enumeration | P2 | ✅ Fixed — PR #51: `requestCode(REGISTER)` is now silent for an already-registered email; the duplicate surfaces at registration commit via the `email` unique constraint, whose error is generic (F-06) |
| F-11 whatsup privacy gate | P3 | ✅ Fixed — PR #51: `showWhatsup` toggle added (default `true`, preserving existing visibility) |
| F-12 SERIALIZABLE tuning | P3 | ⛔ Won't-fix now — **monitor** (accepted 2026-07-15; correct + safe today, revisit only with APM contention data) |

Method: repository-wide, partitioned review (architecture map → partitions →
per-partition read) conducted directly in-session. Every confirmed finding cites
code evidence. No exploit payloads. Fewer high-quality findings preferred over
many vague ones.

---

## 1. Executive Summary

- **Overall security risk: Low–Medium.** No P0. The fundamentals are unusually
  strong for the stage: argon2 password/code hashing, SHA-256 refresh-token
  storage with rotation + reuse detection, per-route rate limiting with a
  never-fail-open fallback, a CORS allowlist, `helmet`, a global whitelisting
  `ValidationPipe`, parameterized-only SQL, and deliberate anti-enumeration on
  login. What remains is hardening + privacy-consistency, not exploitable breaks
  of a core flow.
- **Overall performance risk: Low–Medium.** Well-indexed schema (77 indexes),
  correct money-path transactions, paginated list endpoints. Open questions:
  unbounded-growth tables with no pruning job, and `SERIALIZABLE` cost under
  contention.
- **Overall stability risk: Low.** Graceful shutdown, degraded-boot flags,
  fire-and-forget best-effort writes, outbox retry/backoff.
- **Highest-risk modules:** `upload` (public object store), `user` (profile PII
  consistency), `auth` (access-token lifetime semantics).
- **Production-ready?** Yes from a security/perf standpoint, provided the three
  P1s below are triaged and the deployment-topology questions in §9 are answered.

**Top 5 to fix first**

1. **F-01 (P1):** `/user/search/account` bypasses profile privacy — leaks
   `wechat`/`qq` that GET `/user/:id` correctly hides.
2. **F-02 (P1):** Access tokens are stateless — logout/ban/role-change don't
   invalidate an already-issued access token for up to ~1h.
3. **F-03 (P1):** MinIO bucket is world-readable and published on :9000, so
   `chat`/`notes` media is permanently unauthenticated-readable by URL.
4. **F-04 (P1):** `trust proxy` never set → IP-based rate-limit keying and
   security-log IP attribution are wrong (and spoofable) behind a proxy.
5. **F-05 (P2, →P1 if staging is exposed):** Hardcoded dev email-code bypass
   `999999` is active whenever `NODE_ENV !== 'production'`.

**Assumptions / limitations:** Deep-read auth, guards, user, upload, call, coin,
credit, chat-history, realtime, and error/serialization layers; verified
note/trace/outbox/schema by targeted inspection. Line-by-line review of `circle`,
`circle-plaza`, `circle-invitation`, `group`, `conversation-group`,
`notification`, `collection`, `membership`, `icon` **services** (their
controllers/guards/DTOs were checked) is still pending. `npm audit` not run.

---

## 2. Repository Architecture Map

- **Stack:** NestJS 11 (Express), TypeScript, Prisma 7 with `@prisma/adapter-pg`
  over PostgreSQL. Aux: `ioredis` (optional backplane/rate-limit store), raw `ws`
  WebSocket server, LiveKit (calls), MinIO/S3 (media), OpenIM (external IM via
  HTTP), Winston + daily-rotate logging, Sentry (optional), Prometheus.
  Single-service modular monolith.
- **Entry / startup:** `src/main.ts` `bootstrap()` → `NestFactory.create(AppModule,
  { cors, rawBody })` → `setupApp(app)` (`src/setup.ts`) wires global filters,
  interceptors, `ValidationPipe`, helmet, metrics, and per-route rate limiters →
  attaches the `RealtimeGateway` WS server → `app.listen(port)` → idempotent
  SIGTERM/SIGINT graceful shutdown (drain + flush error aggregation).
- **Auth/session:** `POST /auth/register|login|login-with-code` → argon2 verify →
  `issueTokens()` mints a JWT access token (`{sub, accountId, role, sid}`, TTL
  `JWT_EXPIRES_IN`=1h) + an opaque 64-byte refresh token stored SHA-256-hashed
  (`src/auth/refresh-token.service.ts`). `passport-jwt` strategy is **stateless**
  (`src/auth/auth.strategy.ts`). `JwtGuard` is applied **per-controller**.
- **Network:** Express + `helmet`, CORS allowlist checker, `express-rate-limit`
  backed by a Redis store wrapped in a never-fail-open `FallbackRateLimitStore`.
  Global prefix `api/v1`.
- **Storage/DB/cache:** PostgreSQL via Prisma, Redis optional (Lua `EVAL` atomic
  counters), MinIO/S3 for media, an outbox pattern syncing friend/group to OpenIM.
- **Realtime:** `RealtimeGateway` — raw `ws` at `/realtime`, message-based JWT
  auth, heartbeat, per-user connection cap. Single-instance in-memory map
  (Redis backplane deferred, issue #18).
- **Background:** 7 `@Cron` jobs (friend/group sync outbox, temp-chat/circle-plaza/
  call cleanup, like reconciliation).
- **Observability:** structured Winston loggers, request logger with key
  scrubbing, Prometheus `/metrics` (optional bearer gate), optional Sentry (5xx
  only, sanitized tags).
- **Build/env:** multi-stage `Dockerfile.prod` (non-root user, `npm prune`),
  `docker-compose.prod.yml` (postgres not exposed, MinIO :9000 exposed + console
  loopback-only, one-shot migrate job). Config via `@nestjs/config` + Joi
  (`src/config/env.validation.ts`); `.env*` and `logs/` gitignored & untracked.

---

## 3. Review Partition Plan

| ID | Partition | Files/dirs | Sec | Perf | Priority |
|----|-----------|-----------|-----|------|----------|
| P1 | Auth/session/RBAC | `src/auth/**`, `src/guards/**`, `src/decorators/**`, `src/roles/**` | Med | Low | P0 |
| P2 | User & profile PII | `src/user/**`, `src/privacy/**` | Med | Low | P0 |
| P3 | Social graph authz | `src/friend/**`, `src/group/**`, `src/conversation-group/**`, `src/notification/**` | Med | Med | P1 |
| P4 | Content & visibility | `src/note/**`, `src/circle*/**`, `src/trace/**`, `src/like/**`, `src/collection/**` | Med | Med | P1 |
| P5 | Realtime/IM/chat | `src/realtime/**`, `src/openim/**`, `src/chat-history/**`, `src/temp-chat/**` | Med | Med | P1 |
| P6 | Calls & uploads | `src/call/**`, `src/upload/**`, `src/utils/storage-url.ts` | High | Low | P1 |
| P7 | Virtual economy | `src/coin/**`, `src/credit/**`, `src/mall/**`, `src/membership/**`, `src/icon/**` | High | Med | P1 |
| P8 | Platform infra | `src/prisma/**`, `src/redis/**`, `src/outbox/**`, `src/logs/**`, `src/filters/**`, `src/interceptors/**` | Med | Med | P1 |
| P9 | Observability | `src/logging/**`, `src/metrics/**` | Med | Low | P2 |
| P10 | Build/config/deps | `Dockerfile*`, `docker-compose*`, `src/config/**`, `package.json` | Med | Low | P1 |

**Review order (highest→lowest risk):** P6 → P7 → P1 → P2 → P5 → P4 → P3 → P8 → P10 → P9.

---

## 4. Findings by Priority

No **P0** findings.

### P1 (fix before release)

**F-01 — Profile privacy bypass on account-search endpoint**
- Severity **P1** · Privacy/Authorization · Partition P2 · Confidence High · **Confirmed (still open 2026-07-04)**
- Affected: `src/user/user.service.ts` `findByExactAccountId` (`GET /user/search/account`); `applyProfilePrivacy`; `src/user/user.controller.ts`.
- Description: `findOne` (GET `/user/:id`) runs `applyProfilePrivacy`, nulling `phoneNumber`/`wechat`/`qq` per the target's privacy settings. `findByExactAccountId` returns the same `PUBLIC_SELECT` (contains `wechat`/`qq`/`whatsup`) but **does not** call `applyProfilePrivacy`, and the endpoint serializes to `PublicUserDto`, which `@Expose()`s `wechat`/`qq`/`whatsup`.
- Impact: A user who set WeChat/QQ private still leaks them to anyone who looks them up by exact `accountId` (the friend-add flow). Contradicts the privacy toggle.
- Fix: Route the search result through `applyProfilePrivacy(user, viewerId)` before returning, or select a narrower column set for search.
- Tests: set wechat/qq private → assert both `/user/:id` and `/user/search/account` return `null` for them.

**F-02 — Access token not invalidated on logout / ban / role change**
- Severity **P1** · Security (session) · Partition P1 · Confidence High · **✅ Fixed 2026-07-15 — Redis session revocation (fail-open)**
- Affected: `src/auth/auth.strategy.ts` (stateless `validate`); `src/auth/auth.service.ts` `logout` (revokes only the refresh token).
- Description: `JwtStrategy.validate()` returns claims with **no DB lookup**, and the `sid` claim is never checked against revoked sessions. `logout()` revokes the refresh token only. A leaked/stolen access token — or a banned user's / demoted admin's token — stays valid until natural expiry (`JWT_EXPIRES_IN`=1h).
- Impact: logout gives no immediate server-side invalidation; ban/role-downgrade has up to a 1h window. Partially mitigated: the **refresh** path re-checks `status !== ACTIVE` and revokes.
- Fix: either (a) accept & document the 1h ceiling, or (b) since `sid` is already in the JWT, add a cache-backed session-validity check in the strategy (e.g. a revoked-session set in Redis) so logout/ban take effect immediately without a per-request DB round-trip.
- (Severity is requirement-dependent; downgrade to P2 if a 1h ceiling is acceptable.)

**F-03 — Public object store exposes chat/note media by URL**
- Severity **P1** · Privacy · Partition P6 · Confidence High · **⛔ Won't-fix — accepted 2026-07-15 (media kept public; UUID keys, product-accepted)**
- Affected: `buildPublicReadBucketPolicy` in `src/upload/upload.service.ts`; `docker-compose.prod.yml` (`minio` publishes `9000:9000`, `mc anonymous set download`).
- Description: The bucket policy grants `s3:GetObject` to `Principal:'*'` for prefixes `avatars, covers, posts, notes, chat, uploads`, and MinIO :9000 is published to the internet. Every uploaded object — including **private chat images and note media** — is unauthenticated-readable by anyone with the URL, no expiry.
- Impact: keys are `folder/userId/uuid.ext` (UUIDv4 — not enumerable), so not mass-harvestable, but any leaked URL (screenshots, referer, logs, forwarded links) grants permanent access to what users believe is private DM/notes content.
- Fix: keep `avatars`/`covers` public; make `chat`/`notes` private and serve via short-lived presigned GET URLs (`createPresignedGetUrl` already exists). Restrict :9000 exposure to the app/reverse proxy.

**F-04 — `trust proxy` unset breaks IP rate limiting and log attribution**
- Severity **P1** · Stability/Security · Partition P8/P9 · Confidence Medium · **Needs confirmation (topology-dependent); still unset 2026-07-04**
- Affected: no `app.set('trust proxy', …)` anywhere; `express-rate-limit` keys on `req.ip`; `requestIp.getClientIp` used in `src/filters/all-exception.filter.ts` and request logging.
- Description: with `trust proxy` unset behind a reverse proxy/ALB, `req.ip` becomes the **proxy's** IP → all users collapse into one rate-limit bucket (per-IP brute-force limits stop discriminating). Separately, `request-ip` parses `X-Forwarded-For`, so logged/security-event IPs are client-spoofable.
- Fix: `app.set('trust proxy', <hop count / CIDR>)` matching the real topology (or `false` if directly internet-facing), and derive one client IP for both rate limiting and logging.

### P2 (fix soon)

**F-05 — Hardcoded dev email-code bypass active outside production**
- Severity **P2** · Security · Partition P1 · Confidence High · **Confirmed (still open 2026-07-04)**
- Affected: `src/auth/email-verification.service.ts` `getDevBypassCode` (returns `'999999'` unless `NODE_ENV==='production'` or `EMAIL_CODE_DEV_BYPASS='off'`).
- Impact: in any non-production env, code `999999` passes email verification for register/login. Safe iff every non-dev environment sets `NODE_ENV=production`. If a staging/preprod is internet-reachable with `NODE_ENV !== 'production'` (or holds real data), anyone can register/login as arbitrary emails.
- Fix: gate on an explicit opt-in flag rather than "not production," and assert it can never be true in shared environments.

**F-06 — Prisma unique-conflict leaks the conflicting field name**
- Severity **P2** · Security (enumeration) · Partition P8 · Confidence High · Confirmed
- Affected: `src/filters/prisma-exception.filter.ts` (`P2002` → `Resource already exists: ${target.join(', ')}` + `{ conflict: target }`).
- Impact: names the colliding field (e.g. `email`, `accountId`) — a secondary user-enumeration oracle.
- Fix: return a generic "resource already exists" to clients; keep the field name in the server log only.

**F-07 — Registration/email-code path is a user-enumeration oracle**
- Severity **P2** · Privacy/Security · Partition P1 · Confidence High · **✅ Fixed — PR #51 (2026-07-16)**: `requestCode(REGISTER)` returns silently for an already-registered email, symmetric with the LOGIN-unknown path. Triaged as accept-risk on 2026-07-15, then fixed the next day — this row lagged the code.
- Affected: `src/auth/email-verification.service.ts` (`REGISTER` + existing user → 409 "该邮箱已注册"); `src/auth/auth.service.ts`.
- Impact: requesting a **register** code for an existing email returns a distinct 409, revealing it's registered. (The **login** path is correctly silent for unknown emails; password login uses a single generic error — good.) Gated behind resend cooldown + per-IP `emailCodeLimiter`.
- Fix: if enumeration resistance is required, return a generic "if this email can be registered, we've sent a code" and handle the duplicate at verify time.

**F-08 — No server-side size cap on presigned uploads**
- Severity **P2** · Performance/Abuse · Partition P6 · Confidence High · **✅ Fixed (sizeBytes @Max 100MB + ContentLength binding)**
- Affected: `src/upload/upload.service.ts` `presign` (builds a `PutObjectCommand` with no `ContentLengthRange`).
- Impact: content-type is allowlisted (DTO — good) but there's no max object size. A client can upload arbitrarily large "video/mp4" objects into a public bucket → storage/bandwidth abuse, disk exhaustion. Presign is rate-limited per user (20/min), which bounds count but not per-object size.
- Fix: enforce a max size via a presigned POST policy (`content-length-range`) or a MinIO per-bucket object-size limit; validate declared size in the DTO.

**F-09 — Unbounded-growth tables without a pruning job**
- Severity **P2** · Performance/Stability · Partition P8 · Confidence Medium · **✅ Fixed 2026-07-15 — daily refresh-token pruning cron** (Notification/FriendActivity retention still a product decision)
- Affected: `RefreshToken`, `Notification`, `FriendActivity` (schema); ledgers `CoinTransaction`/`CreditEvent` (intentionally retained).
- Impact: `RefreshToken` rows are marked revoked/expired but never deleted; `Notification`/`FriendActivity` grow indefinitely. Cleanup crons exist for temp-chat/circle-plaza/calls but not these. Gradual (tables are well-indexed), not acute.
- Fix: low-frequency cron to delete refresh tokens where `expiredAt < now()` (or `revokedAt` older than N days) and to archive/expire old notifications.

### P3 (optimization / hardening)

**F-10 — Leftover debug scaffolding with `console.log` in `LogsController`**
- Severity **P3** · Maintainability/Security-hygiene · Partition P8 · Confidence High · **Confirmed (still open 2026-07-04)**
- Affected: `src/logs/logs.controller.ts` (`postTest` `console.log(... dto)`; `getTest` returns `'test'`).
- Note: Admin+CASL-guarded (low risk), but it's dead scaffolding that echoes input and writes a `console.log` (violates the no-`console.log` rule; could surface request data in stdout).
- Fix: remove the placeholder controller or use the structured logger.

**F-11 — `whatsup` (WhatsApp) never privacy-gated**
- Severity **P3** · Privacy consistency · Partition P2 · Confidence High · **✅ Fixed — PR #51 (2026-07-16)**
- **Note:** `whatsup` is a free-text public status line (DTO example "Coding every day", `@MaxLength(100)`, grouped with `persona`/`helloWords`), **not** a WhatsApp/contact handle — so it was first triaged as a false positive. PR #51 gated it anyway via `showWhatsup` (default `true`), which keeps it publicly visible while giving users an opt-in switch consistent with `showWechat`/`showQQ`. The semantic point stands; the gate is a harmless superset.
- Affected: `applyProfilePrivacy` gates only phone/wechat/qq; `whatsup` is `@Expose()`d on `PublicUserDto`.
- Fix: include `whatsup` in the privacy-gated set if it's considered contact PII.

**F-12 — `SERIALIZABLE` transactions on hot wallet/credit rows**
- Severity **P3** · Performance · Partition P7 · Confidence Medium · **⛔ Won't-fix now — monitor (accepted 2026-07-15)**; correct + safe today, revisit only with APM contention data
- Affected: `runSerializableTransaction` in `sendGift`/`adminTopUp` (`src/coin/coin.service.ts`) and `applyDelta` (`src/credit/credit.service.ts`).
- Note: correct and safe, but `SERIALIZABLE` can produce serialization failures/retries under concurrent writes to a popular recipient/creditee. The atomic conditional `updateMany`/`FOR UPDATE` alone already prevents lost updates at a lower isolation level.
- Fix: consider `READ COMMITTED` + existing atomic guards + explicit retry-on-40001 for throughput, if APM shows contention. Not urgent.

---

## 5. Security Review Matrix

| Area | Partitions | Issue? | Highest sev | Evidence | Recommendation | Conf |
|------|-----------|--------|-------------|----------|----------------|------|
| Injection (SQL/NoSQL/cmd) | P1–P8 | No | — | all `$queryRaw`/`$executeRaw` parameterized; no `*Unsafe`; chat-history uses OpenIM HTTP not Mongo | lint-ban `*Unsafe` | High |
| XSS/CSRF/SSRF/WebView | P2,P4,P6 | Partial | P3 | `assertUrlsFromStorage` blocks off-origin/`javascript:`/`data:`; gift/message rejects `<>`; no server-rendered HTML; no WebView | keep URL guard on all stored-URL fields | High |
| Authentication | P1 | Minor | P2 | argon2 + generic login error; refresh reuse-detection revokes all | F-07 register enumeration | High |
| Session/token/cookie | P1 | Yes | P2 (F-02) | stateless JWT; refresh SHA-256 hashed + rotated | add revocation check or document TTL | High |
| Authorization/RBAC | P1,P3,P4 | No (core) | — | JwtGuard per-controller; AdminGuard on admin routes; ownership checks on user update/delete | complete service-internal pass (§9) | Med |
| IDOR / object-level | P2,P4,P5 | No (verified paths) | — | note→404 on non-owner; trace visibility enforced; chat-history validates conversation membership | verify circle/group service internals | Med |
| Sensitive data storage | P2,P7 | Minor | P2 (F-01) | PII gated on profile; search bypasses it | apply privacy filter on search | High |
| Sensitive logging | P9 | No | — | `AllExceptionFilter` scrubs password/token/cookie keys; body omitted; stack only in logs | keep | High |
| HTTPS/TLS/cert | P10 | Unknown | P1? | :3000 published directly in compose; no TLS in app | confirm reverse-proxy TLS (§9) | Low |
| File upload/download | P6 | Yes | P1 (F-03), P2 (F-08) | public bucket; no size cap; type/folder allowlisted | private prefixes + presigned GET + size cap | High |
| Local file handling | P6 | No | — | UUID keys, filename regex-validated, no path traversal | — | High |
| Third-party SDKs/deps | P10 | Unknown | — | modern versions; `multer`/`picomatch` overrides present | run `npm audit` (§9) | Low |
| Permissions/privacy | P2,P5 | No | — | privacy service consulted; `whatsup` gated via `showWhatsup` (PR #51) | — | High |
| Debug/test entry points | P1,P8 | Yes | P2 (F-05), P3 (F-10) | dev code bypass; logs scaffolding; Swagger prod-off | explicit opt-in flags | High |
| Build/release config | P10 | Minor | P2 | non-root image, prune; `.env`/`logs` gitignored | confirm `NODE_ENV=production` everywhere | Med |

---

## 6. Performance Review Matrix

| Area | Partitions | Issue? | Highest sev | Evidence | Recommendation | Conf |
|------|-----------|--------|-------------|----------|----------------|------|
| Startup cost | P8,P10 | No | — | lazy/optional Redis/MinIO/OpenIM; degraded-boot flags | — | High |
| Main-thread blocking | P1,P8 | No | — | argon2 async native; no sync fs/crypto in hot paths | — | High |
| List performance | P2,P7 | Minor | P3 | `getTransactions` `take:50`; `findAll` paginated; some `findMany` unverified for `take` | audit remaining `findMany` for caps | Med |
| Image/media loading | P6 | Yes | P2 (F-08) | no size cap on presign | cap object size | High |
| Network performance | P5 | Minor | P3 | OpenIM outbound calls; chat-history cursor-paginated | confirm outbound timeouts | Med |
| Caching strategy | P2 | No | — | profile-summary cache with invalidate-on-write | — | Med |
| Memory leaks | P5 | No | — | WS: WeakMap/WeakSet, timers cleared on close, heartbeat reap | — | High |
| OOM risk | P6 | Minor | P2 (F-08) | unbounded upload size; `downloadObjectBuffer` has `maxBytes` | cap uploads | Med |
| Background/battery | P3,P4 | No | — | outbox claim+backoff; cleanup crons | — | High |
| DB & file I/O | P3,P7,P8 | Minor | P2 (F-09) | 77 indexes incl. `[status,nextAttemptAt]`; unbounded tables lack pruning | add prune jobs | Med |
| App size/deps | P10 | Unknown | — | slim image, prune | `npm audit` (§9) | Low |
| Crash/ANR/blank-screen | P8 | No | — | graceful shutdown, global filters, best-effort writes | — | High |

> Note (post-audit): the moments (`trace`) and circle-plaza feeds have since moved
> from offset+`count()` to `(createdAt, id)` keyset pagination with dedicated
> composite indexes — see the `feat(feed): keyset cursor pagination` commit. This
> addresses the "audit remaining findMany" item for those two hot feeds.

---

## 7. Recommended Tests

**Security**
- *Auth:* generic-error parity for unknown-user vs wrong-password (and timing); refresh-token reuse revokes all sessions; password change invalidates sessions.
- *Authorization/IDOR:* accept a friend request not addressed to you; mark another user's notification read; read a non-owned note (expect 404); read a `PRIVATE`/`FRIENDS_ONLY` trace as a stranger (expect 403).
- *Input validation:* negative/zero/`1e9`/`NaN` gift amounts rejected; presign rejects non-allowlisted content-type/folder; `<>` in gift message rejected.
- *Sensitive storage (F-01):* wechat/qq set private are hidden on **both** `/user/:id` and `/user/search/account`.
- *Network (F-04):* forged `X-Forwarded-For` does not change the enforced rate-limit key.
- *File upload (F-03/F-08):* unauthenticated GET of a `chat` object is denied; oversized upload is rejected.
- *Permissions/privacy (F-05):* dev bypass code `999999` is rejected when `NODE_ENV=production`.

**Performance**
- Startup-time baseline; no main-thread block under 100 concurrent logins (argon2 pool).
- Weak-network: OpenIM/LiveKit outbound timeouts don't stall login (imToken degrades to empty).
- Large-data: notification/friend-activity lists at 10k+ rows stay paginated.
- List scrolling: feed cursor pagination returns stable pages.
- Memory-leak: open/close 10k WS connections, assert no growth.
- DB I/O: outbox poll query uses the `[status, nextAttemptAt]` index (EXPLAIN).

**Stability**
- Malformed API response from OpenIM/LiveKit handled without 5xx cascade.
- Timeout/offline: DB down with `ALLOW_START_WITHOUT_DB` degraded boot.
- Lifecycle: SIGTERM drains in-flight requests and flushes Sentry.
- Multi-account: single-device-login revokes other sessions; concurrent refresh doesn't fork sessions (TOCTOU).

---

## 8. Fix Roadmap

**1. Fix immediately (before release)**
- **F-01** (user/privacy) — apply `applyProfilePrivacy` on search. Regression risk: Low.
- **F-03** (upload/infra) — private `chat`/`notes` prefixes + presigned GET; restrict :9000. Regression risk: Medium (clients must fetch via presigned URLs).
- **F-04** (infra) — set `trust proxy` correctly. Regression risk: Low.

**2. Fix before release (or fast-follow)**
- **F-02** (auth) — decide stateless-vs-revocable; implement or document. Regression risk: Medium.
- **F-05** (auth/devops) — explicit opt-in for dev bypass + assert prod. Regression risk: Low.
- **F-08** (upload) — server-side size cap. Regression risk: Low.

**3. Optimize soon**
- **F-06** generic conflict messages; **F-09** pruning jobs for refresh tokens/notifications.

**4. Monitor later**
- **F-12** (isolation-level tuning under real load) — revisit only with APM contention data.

---

## 9. Review Gaps & Follow-up Questions

- **Service-internal review incomplete** for: `circle.service`, `circle-plaza.service`,
  `circle-invitation.service`, `group.service`, `conversation-group.service`,
  `notification.service`, `collection.service`, `membership.service`, `icon.service`,
  `openim.service`, and the remaining `note.service` internals. Their controllers,
  guards, and DTOs were checked and are consistent with the rest of the codebase,
  but IDOR/perf inside those services is not yet fully confirmed.
- **Deployment topology (F-04, TLS):** does a reverse proxy/ALB terminate TLS in
  front of the app, or is :3000 exposed directly? Determines the `trust proxy` fix
  and whether JWT-bearing traffic ever travels plaintext.
- **`NODE_ENV` on non-dev environments (F-05):** confirm staging/preprod set
  `NODE_ENV=production` (or `EMAIL_CODE_DEV_BYPASS=off`) and are not internet-reachable
  with the bypass active.
- **Object-store intent (F-03):** are `chat`/`notes` media meant to be private?
- **Dependency scan (P10):** `npm audit --omit=dev` not run this pass; review
  `.trivyignore` justifications before release.
- **Retention policy (F-09):** product decision on refresh-token/notification pruning.
- **APM/real-device data (F-12):** no production latency/contention data to confirm
  whether `SERIALIZABLE` retries are a real bottleneck.

---

**Bottom line:** No P0. The security fundamentals are notably above average — money
paths, refresh-token lifecycle, WebSocket auth, error sanitization, and SQL
parameterization are done correctly and defensively. The real work is three
privacy/session P1s (search-endpoint privacy bypass, stateless-token semantics,
public media bucket), the proxy-IP configuration, and completing the
service-internal pass in §9.
