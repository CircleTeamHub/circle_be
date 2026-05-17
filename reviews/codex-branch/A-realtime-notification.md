# Production Review — Realtime + Notification Module (`codex/dev-test-logging`)

Scope: `src/realtime/*` and `src/notification/*` (9 files, 999 LOC, all net-new vs `main`).
Methodology: nestjs-production-review 5-boundary patterns (A–F) + WebSocket auth/authz focus.

---

## 1. TL;DR — Findings by Severity

| # | Severity | File:Line | Description |
|---|----------|-----------|-------------|
| 1 | HIGH | realtime.gateway.ts:78-87 | Deprecated URL-token auth still active — JWT placed in WS connect URL is logged/cached, token leaks via access logs & proxies |
| 2 | HIGH | realtime.gateway.ts:202-214 | `jwtService.verify` accepts ANY token signed with the shared secret — a refresh token (or any other token type) is accepted as a realtime credential; no `type`/audience check |
| 3 | MEDIUM | realtime.gateway.ts:94 | `socket.once('message')` only consumes the first frame for auth; no validation/handler on subsequent frames — but also no max-payload limit on the auth frame (unbounded JSON parse) |
| 4 | MEDIUM | realtime.gateway.ts:46-48, 71 | Connection handler runs before auth; a flood of unauthenticated sockets can be held open for the full 10s `AUTH_TIMEOUT_MS` with no per-IP connection cap (only per-user, post-auth) |
| 5 | MEDIUM | notification.service.ts:83-138 | `createTraceCommentNotifications` issues up to 2 `notification.create` writes via `Promise.all` with no transaction wrap — partial failure orphans one notification |
| 6 | LOW | notification.controller.ts:15,21 | `@Req() req: any` — untyped request, identity read as `req.user.userId` with no typed contract |
| 7 | LOW | notification.controller.ts:19 | `POST /notification/profile/read-all` has no throttle and no idempotency guard (idempotent by nature, but unthrottled) |
| 8 | LOW | realtime.service.ts:152-154 | `systemUnread` and `profileUnread` are both assigned `profileUnread` — likely a copy/paste bug producing duplicated badge counts |
| 9 | LOW | realtime.gateway.ts:82-84 | `logger.warn` logs the `userId` of every legacy-auth client — PII-ish identifier in logs at WARN volume |

No global `ValidationPipe` issue specific to this module (it is registered in `src/setup.ts:168`), and no global exception filter is active (commented out in `src/setup.ts:163-165`) — noted but out of this module's scope.

---

## 2. Per-File Walkthrough

### `src/realtime/realtime.gateway.ts`

**HIGH — #1 — Deprecated URL-token auth still live (lines 78-87, 193-200).**
`authenticateFromUrl` reads `?token=` from the WS upgrade request URL and, if present, authenticates the socket immediately. A JWT in a URL is the canonical token-leak vector: it lands in nginx/ALB access logs, browser history, CDN/proxy caches, and `Referer` headers. The comment says "kept for backward compatibility" but there is no flag, deadline, or metric gating it — it is unconditionally honored on every connection. The code even logs the leak path (`logger.warn(... deprecated URL-token auth ...)`) but still accepts it.
- **Impact:** Any access-log reader (ops, log aggregator, compromised proxy) recovers a live 15-min access token and can impersonate the user over both REST and WS.
- **Repro:** `wscat -c "ws://host/realtime?token=<accessJWT>"` → connection authenticated, snapshot emitted; token now in the server access log.
- **Fix direction:** remove URL auth entirely, or gate behind an env flag defaulted off, before merge.

**HIGH — #2 — No token-type / audience discrimination (lines 202-214).**
`verifyToken` calls `jwtService.verify<JwtPayload>(token)` with the module secret (`realtime.module.ts:13`, same `ConfigEnum.SECRET` as `auth.module.ts`). It checks only that `sub` is a string. Access tokens are signed with `{ sub, accountId, role }` (`auth.service.ts:359`) and refresh tokens are signed with the same secret elsewhere. Any token signed with that secret — including a refresh token — will pass and grant a realtime session. The token's `type`/`aud` is never asserted.
- **Impact:** A refresh token, which typically has a much longer TTL than the 15-min access token, can be used to hold an indefinite realtime session. Defeats the access-token short-TTL design.
- **Fix direction:** assert an explicit `type === 'access'` (or `aud`) claim in `verifyToken`; reject everything else.

**MEDIUM — #3 — Unbounded auth-frame parse (line 94-110, parseAuthMessage 174-191).**
`socket.once('message', ...)` → `JSON.parse(data.toString('utf8'))` with no `maxPayload` set on the `WebSocketServer` (line 41-44 omits it; `ws` default is 100 MB). A pre-auth client can send a ~100 MB frame and force a large allocation + parse before any auth check. `parseAuthMessage` correctly rejects non-`auth` shapes, but only after the full parse.
- **Impact:** Memory-pressure DoS from unauthenticated clients.
- **Fix direction:** set `maxPayload` (e.g. 4 KB) on the `WebSocketServer` constructor.

**MEDIUM — #4 — No per-IP connection cap pre-auth (lines 46-48, 71-92).**
`handleConnection` is invoked on every upgrade; the socket is held for up to `AUTH_TIMEOUT_MS` (10s) before being closed if auth never arrives. `MAX_CONNECTIONS_PER_USER` (5) is enforced only *after* auth (line 128-132). There is no per-IP limit on concurrent unauthenticated sockets.
- **Impact:** An attacker opens thousands of sockets, never authenticates, and ties up FDs/memory for 10s each — connection-table exhaustion.
- **Fix direction:** track unauthenticated socket count per remote address, or shorten the timeout and rate-limit upgrades at the proxy.

**LOW — #9 — `userId` logged at WARN on every legacy connection (line 82-84).** High-volume identifier logging; demote-or-scrub. Not a token leak, so LOW.

**Verified OK in this file:**
- Server-derived identity: `userId` always comes from `verifyToken` (the verified JWT `sub`), never from a client-supplied field. `acceptAuthenticatedSocket` takes `userId` only from verified sources. Pattern B satisfied.
- No room-join / subscribe message handler exists — clients cannot request another user's room; the only routing key is the server-derived `userId`. Cross-user event leakage (A→B) is not possible via subscribe.
- Heartbeat/liveness: ping/pong with `WeakSet` liveness tracking and `terminate()` on dead sockets is correct.
- Token-expiry timer (lines 137-147) proactively closes sockets when the JWT `exp` passes — good, prevents stale-token sessions.
- `onModuleDestroy` clears the heartbeat interval and closes the server — no timer leak.
- `WeakMap`/`WeakSet` keyed by socket — no memory leak on disconnect; `close` handler also explicitly unregisters.
- Auth-message parse is wrapped in try/catch; malformed JSON closes the socket with `1008` rather than crashing.
- `socket.on('error')` handlers exist both pre- and post-auth — no unhandled `error` events.

### `src/realtime/realtime.service.ts`

**LOW — #8 — Badge snapshot field duplication (lines 149-156).**
`buildSnapshot` returns `profileUnread` *and* `systemUnread`, both assigned the identical `profileUnread` value. `discoverUnread` correctly sums `circleUnread + discoverNotificationUnread`. The `systemUnread = profileUnread` line looks like a copy/paste artifact — either `systemUnread` should be its own query or the field is redundant. Confirm intent; mislabeled badge counts are a UX bug, not a security one → LOW.

**Verified OK:**
- `broadcast` (lines 365-384) is strictly scoped to `this.clients.get(userId)` — events fan out only to the target user's own sockets. No unbounded/global broadcast; no cross-user delivery. Pattern B satisfied for the emit side.
- `broadcast` checks `socket.readyState === WebSocket.OPEN` and wraps `socket.send` in try/catch — a dead/erroring socket cannot crash a broadcast.
- `safeBroadcastAll` uses `Promise.allSettled` + per-fn try/catch — a WS failure provably cannot bubble into the HTTP response of the calling business operation (verified caller `coin.service.ts:284-300`). Pattern F (defensive downstream) satisfied for the realtime side.
- `wallet.balance.changed` / `wallet.recharge.completed` deliberately omit absolute balance (only `delta`) — PII minimization over the transport; spec'd in the doc comment and covered by tests.
- Count queries are parallelized with `Promise.all` (no N+1).
- Error logs use `error.message` only, never the raw event payload or token — no PII/secret leakage in logs.
- All `count` queries are scoped by `viewerId`/`viewerID`/`toUserID` = the server-derived `userId` — no way to count another user's unread.

### `src/realtime/realtime.module.ts`
**Verified OK:** `JwtModule` configured with `ConfigEnum.SECRET` via async factory. Exports both providers. *Note (informational):* it does not set `verifyOptions`, which is why finding #2 (no token-type check) is possible — the verify call has no audience constraint.

### `src/notification/notification.controller.ts`

**LOW — #6 — Untyped request (`@Req() req: any`, lines 15, 21).** Identity is read as `req.user.userId`. `JwtGuard` populates `req.user` via `JwtStrategy.validate` (`auth.strategy.ts:18-22`), so identity *is* server-derived (Pattern B satisfied) — but `any` defeats compile-time checks. Use a typed `AuthenticatedRequest`.

**LOW — #7 — No throttle on `POST /profile/read-all` (line 19).** The endpoint is naturally idempotent (`updateMany ... data:{read:true}`), so missing idempotency is not a real defect. But there is no `@Throttle`/rate guard; a client can hammer it. A global IP fallback limiter exists (`setup.ts:184` comment) — confirm it covers this route. Low impact.

**Verified OK:**
- Controller-level `@UseGuards(JwtGuard)` protects both routes — no unauthenticated access. Pattern checked.
- Both handlers pass `req.user.userId` (verified-token identity) straight to the service; no client-supplied `userId` accepted. Pattern B satisfied.
- No `@Body`/`@MessageBody` on either route (both take no payload) — no DTO needed; Pattern A not applicable here.

### `src/notification/notification.service.ts`

**MEDIUM — #5 — Multi-row create without a transaction (`createTraceCommentNotifications`, lines 83-138).**
The method builds up to two independent `prisma.notification.create` promises (trace-owner notification + reply-target notification) and resolves them with `await Promise.all(notifications)` (line 136). These are two writes to the same `notification` table. If the second `create` fails, the first has already committed — the trace owner gets notified but the reply-target does not, and the caller (`trace.service.ts:268`) receives a thrown error after a partial write, with no rollback. Pattern C (transaction wrap for ≥2 writes) is violated.
- **Impact:** Inconsistent notification state on partial failure; the caller cannot safely retry without risking a duplicate trace-owner notification.
- **Fix direction:** wrap the creates in `prisma.$transaction([...])`.

**Verified OK:**
- `createSystemNotification` (lines 64-81) defends identity: returns `null` unless `toUserId === fromUserId` and both are present — cannot be used to spam an arbitrary user. Server-derived in callers (`coin.service.ts:273`, `membership.service.ts:94` pass `userId, userId`).
- `markProfileNotificationsRead` scopes `updateMany` strictly by `toUserID: userId` — a user can only mark *their own* notifications read. No cross-user write.
- Broadcast-after-write is correctly skipped when `result.count === 0` (no-op optimization) and is awaited *after* the DB write, so a WS failure does not roll back the read state.
- `createTraceCommentNotifications` dedupes recipients via a `Set` (`notifiedUserIds`) — the trace owner won't be double-notified if they are also the reply target.
- `getUnreadSummary` parallelizes its two counts and scopes both by `toUserID: userId` — no N+1, no cross-user read.

### `src/notification/notification.module.ts`
**Verified OK:** `@Global()` is appropriate (the service is consumed by `coin`, `trace`, `membership`). Imports `RealtimeModule` for the broadcast dependency.

### Spec files (`realtime.service.spec.ts`, `notification.service.spec.ts`)
**Verified OK:** Cover the snapshot builder, connection-count default, `safeBroadcastAll` failure isolation (sync + async), wallet-event PII omission, read-all broadcast, and the no-rows skip path. **Gap (not blocking):** no test exercises `realtime.gateway.ts` at all — WS auth, token verification, expiry timer, and connection cap are entirely uncovered. The two HIGH findings live in untested code. Recommend gateway tests before/with the auth fix.

---

## 3. Verified-OK Summary

- Emit-side authorization is sound: `broadcast` fans out only to the target user's own sockets; no subscribe/room-join handler exists, so cross-user event leakage is structurally impossible.
- Server-derived identity is consistently respected — WS `userId` from verified JWT `sub`, REST `userId` from `JwtGuard`-populated `req.user`; no endpoint trusts a client-supplied id.
- `markProfileNotificationsRead` / `getUnreadSummary` / count queries are all scoped to the caller's id — no IDOR.
- WS lifecycle is correct: heartbeat liveness, expiry timers, `WeakMap`/`WeakSet` cleanup, error handlers, `onModuleDestroy` teardown — no leaks.
- `safeBroadcastAll` provably isolates WS failures from HTTP responses (`Promise.allSettled` + try/catch).
- Wallet events deliberately omit absolute balance — PII minimization, test-enforced.
- Error logs carry only `error.message` — no tokens, payloads, or PII in logs (except finding #9's `userId`).
- `createSystemNotification` self-targets only — cannot be weaponized to notify arbitrary users.

---

## 4. Phase Verdict

**NOT merge-ready.** Two HIGH findings must be resolved first:

- **#1 (URL-token auth)** — a live access token is written to access logs on every legacy connection. This is an active credential-leak path, not a hypothetical one.
- **#2 (no token-type check)** — any token signed with the shared secret, including a long-lived refresh token, is accepted as a realtime credential, defeating the short access-token TTL.

Both live in `realtime.gateway.ts`, which has **zero test coverage** — fix and add gateway tests together.

**Should fix before merge:** #5 (transaction wrap on `createTraceCommentNotifications` — orphaned notifications on partial failure). #3 and #4 (pre-auth DoS surface) are MEDIUM hardening — acceptable as a fast follow-up if the proxy provides upgrade rate-limiting, but `maxPayload` (#3) is a one-line fix and should go in now.

**LOW items** (#6 typed request, #7 throttle, #8 badge-field duplication, #9 log volume) — clean up but non-blocking. #8 should be confirmed with the author since it may be a real UX bug.

Recommendation: block merge until #1 and #2 are fixed and gateway auth tests exist; address #5 in the same change.
