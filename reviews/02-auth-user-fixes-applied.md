# Phase 1 — Fixes Applied

> Companion to [`02-auth-user.md`](./02-auth-user.md). Lists what was actually changed,
> what was deferred and why, and what still requires user action.

**Verification**: `npx tsc --noEmit` 0 errors · `jest` 27 suites / 122 tests pass (added 4 new tests covering reuse detection, refresh-status block, login uniform error, device-name truncation).

---

## ✅ Applied

### HIGH (all six addressed)

| Finding | Location | Change |
|---|---|---|
| #1 hardcoded TTLs | `src/auth/auth.module.ts`, `src/auth/refresh-token.service.ts` | JWT `expiresIn` now reads `JWT_EXPIRES_IN` env (`?? '1h'`); refresh TTL reads `REFRESH_EXPIRES_IN_DAYS` env (`?? 7`). Both wired through ConfigService |
| #2 BAN/DELETE without revoke | `src/user/user.service.ts:202-227` | `remove()` always calls `refreshTokens.revokeAll(id)`; `updateStatus()` calls it whenever `status !== ACTIVE`. `RefreshTokenService` is now injected into `UserService` |
| #3 refresh ignores status | `src/auth/auth.service.ts:163-205` | After `rotate()` resolves, refetch user and if `status !== ACTIVE` → `refreshTokens.revokeAll(id)` + `ForbiddenException`. Closes the loop with fix #2 |
| #4 `username` dead field | `src/user/dto/public-user.dto.ts` | Removed the `@Expose() username` block — model never had this column |
| #5 login enumeration oracle | `src/auth/auth.service.ts:115-135` | `!user` and `status !== ACTIVE` now both surface as the same `ForbiddenException('Invalid credentials')`; the real reason is logged server-side via `logger.warn` |
| #6 unbounded account search | `src/setup.ts`, `src/auth/auth.module.ts` | New `accountSearchLimiter` (30 req / 15 min / IP) wired to `/api/v1/user/search/account` |

### MEDIUM (mostly addressed)

| Finding | Location | Change |
|---|---|---|
| #7 refresh-token reuse detection | `src/auth/refresh-token.service.ts:73-110` | On `updateMany` count=0, do a `findUnique` lookup — if the row exists with `revokedAt` set, treat as a replay attack: `revokeAll(userId)` and throw `UnauthorizedException('Refresh token reuse detected; all sessions revoked')` with a server-side warning |
| #8 unbounded device name / IP / UA | `src/auth/refresh-token.service.ts:21-33` | New `truncate()` helper enforces `MAX_DEVICE_NAME_LENGTH=64`, `MAX_USER_AGENT_LENGTH=256`, `MAX_IP_LENGTH=64` before persisting |
| #9 RefreshTokenService not exported | `src/auth/auth.module.ts:34` | Added `RefreshTokenService` to `exports` (required for fix #2) |
| #10 `me()` fabricates response | `src/auth/auth.service.ts:209-228` | Rewrote to: fetch user → fire-and-forget update (no `.then` chain, no fabricated catch) → return `{...user, lastOnline: now}` synthesized from the fresh fetch. No more silent-failure swallowing |
| #12 unbounded `limit` | `src/user/dto/get-user.dto.ts` | Added `@Max(100)` on `GetUserDto.limit` |
| #13 unbounded logout | `src/setup.ts` | New `logoutLimiter` (60 req / 15 min / IP) wired to `/api/v1/auth/logout` |
| #17 missing rotate tests | `src/auth/__test__/refresh-token.service.spec.ts` | Added: rotates valid token (happy path), reuse detection revokes all sessions, truncates overlong device name |
| #18 stale `u.username` mock | `src/auth/__test__/auth.service.spec.ts:62-69` | Changed to `u.accountId === where.accountId` (matches the actual schema) |
| #19 `CreateUserInput` accepts dead email/phone | `src/user/user.service.ts:18-23, 177-188` | Removed `email` / `phoneNumber` from `CreateUserInput` and the `create()` call — they were never wired from `CreateUserDto` anyway. `AuthService.register` still uses them via `RegisterDto` (unaffected) |

### LOW (selected)

| Finding | Location | Change |
|---|---|---|
| LOW-29 nickname length drift | `src/auth/dto/register.dto.ts` | `@Length(1, 50)` to match `UpdateUserDto.nickname` |
| LOW-32 sessions not serialized | `src/auth/auth.controller.ts:107-119` + `src/auth/dto/auth-session.dto.ts` | Added `@Serialize(AuthSessionDto)` on the sessions endpoint; DTO fields now carry `@Expose()` so the strict serializer doesn't drop them |
| LOW-20 `CheckPolices` typo | `src/decorators/casl.decorator.ts:18` | Renamed to `CheckPolicies`. Safe rename — confirmed zero call sites elsewhere in the codebase |
| LOW-22 dead `SigninUserDto` | `src/auth/dto/signin-user.dto.ts` | `git rm` — `LoginDto` is the real DTO |
| LOW-25 no-op `CreateUserPipe` | `src/user/pipes/create-user.pipe.ts` (+ directory) | `git rm` — file was a passthrough |

### Added tests

| File | Tests added |
|---|---|
| `src/auth/__test__/auth.service.spec.ts` | `login returns the same error for unknown vs inactive accounts` — verifies oracle fix; `refresh blocks inactive users and revokes their sessions` — verifies fix #3 |
| `src/auth/__test__/refresh-token.service.spec.ts` | `truncates overlong values` (#8), `rotates a valid refresh token and revokes the old record` (#7 happy path), `detects refresh token reuse and revokes all sessions for the user` (#7 sad path), updated to inject `ConfigService` |
| `src/user/__tests__/user.service.spec.ts`, `src/user/__tests__/user.update-normalization.spec.ts` | Both updated to provide a `RefreshTokenService` mock to the `UserService` constructor (no behavior tests added — Phase 9 backlog) |

---

## ⏸️ Deferred — full inventory of unfixed Phase 1 findings

### Still open (HIGH/MED that need explicit deferral context)

| ID | Why deferred |
|---|---|
| #11 `PublicUserDto` shows `wechat`/`qq`/`whatsup` to any authenticated user | Product decision (likely intended for friend-finding flow). Move to `SelfUserDto` or introduce a `FriendVisibleUserDto` when PM confirms the privacy contract |
| #14 `logoutAll` doesn't kill the current access token | Requires either an access-token blacklist (Redis) or shortening JWT TTL across the board (now configurable via `JWT_EXPIRES_IN` after fix #1). Recommended next step: ship with `JWT_EXPIRES_IN=5m` and ride out the trade-off until the blacklist arrives |
| #15 OpenIM retry has no backoff or counter | Best done as a dedicated reconciliation cron + circuit breaker. Held until Phase 8 (OpenIM module review) confirms the failure modes |
| #16 `lastUsedAt` is functionally `createdAt` | Updating `lastUsedAt` requires either (a) per-API-hit DB write in `JwtStrategy.validate` (perf cost on every request) or (b) periodic batched update via Redis. Both are wider design choices than a Phase 1 fix |
| MED `assertUrlsAreSafe` uses `startsWith` | Trivial fix (parse URL and compare `origin`) but didn't want to ship without confirming the `MINIO_PUBLIC_URL` value families in production. Held for Phase 7 (upload review) |

### LOW still open (cosmetic / coverage)

| Where | Issue |
|---|---|
| `src/auth/auth.strategy.ts:17` | `validate(payload: any)` — add typed `JwtPayload` interface. Cosmetic |
| `src/auth/casl-ability.service.ts` | TODO + admin-only;CASL is wired but no policy is actually used (`@CheckPolicies`/`@Can`/`@Cannot` have zero call sites). Either remove CASL entirely or implement real policies |
| `src/auth/dto/refresh-token.dto.ts:5` | `REFRESH_TOKEN_LENGTH = 128` still hardcoded. Could derive from the same env, but coupling DTO validation length to backend secret size is also weird; leave the magic number |
| `src/auth/dto/register.dto.ts` | accountId has no character set whitelist (could register emoji-only accountId); password has no complexity rule |
| `src/auth/dto/auth-tokens.dto.ts:15` | `imToken: string` is required in the type but service returns `''` on OpenIM failure — Swagger and runtime disagree. Cosmetic |
| `src/auth/auth.controller.ts` | `@Req() req: any` in 4 places. Introduce a `RequestWithUser` alias |
| `src/utils/account-id.ts` | `randomBytes % 36` modulo bias; collision retry not handled at callers. Distinct work item |
| `src/user/user.controller.ts:75-81` | `getUser` lets any authenticated user fetch any profile; bundled with #11 product decision |
| `src/user/user.controller.ts` | `@Param('id')` no UUID validator. Add a `ParseUUIDPipe` later |
| `src/user/user.service.ts:67-87` | `normalizeBirthdayInput` defensive layer accepts `new Date(any)`; DTO `@IsDateString` already pre-validates — keep as belt-and-braces |
| `src/user/dto/public-user.dto.ts:34-44` | Same #11 social-handle visibility |
| `src/auth/__test__/auth.service.spec.ts` | No test for `changePassword`, `logout`, `me 404`, `register` with conflict. Coverage backlog |
| `src/user/__tests__/*` | No tests for `findAll`, `findOne`, `update`, `remove`, `updateStatus` — only `findByExactAccountId` is touched. Backlog |
| `src/user/dto/update-user.dto.spec.ts` | One happy-case only; missing negative cases |
| Several controllers | Response envelope `{ data, total, page, limit }` gets double-wrapped by `ResponseInterceptor` → client sees `data.data.data`. Cross-cutting issue tracked for Phase 9 |
| `src/auth/refresh-token.service.ts` | SHA-256 (not HMAC). Acceptable for 256-bit random tokens; would matter only if token entropy dropped |

---

## 🚨 Required follow-up actions (user)

1. **Set `REFRESH_EXPIRES_IN_DAYS` and `JWT_EXPIRES_IN` in your local `.env.development`** if you want non-default values. The defaults (`7` days, `1h`) take over otherwise — they're identical to the previous hardcoded values, so nothing breaks if you do nothing
2. **Re-run the dev server** to pick up the new global rate limiters (`/auth/logout`, `/user/search/account`)
3. **Inform the frontend team** about two breaking shape changes:
   - `GET /api/v1/auth/sessions` now strips fields not in `AuthSessionDto` (was returning raw Prisma row)
   - `PublicUserDto.username` no longer exists in the response — was always `undefined` anyway, but client TS types should be updated
4. **Decide on PM-level questions** flagged in Deferred: `wechat/qq/whatsup` visibility, JWT TTL trade-off vs access-token blacklist

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 27 passed, 27 total
Tests:       122 passed, 122 total       (was 118 before this patch)
```
