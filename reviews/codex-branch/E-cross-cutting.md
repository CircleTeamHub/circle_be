# Phase E — Cross-Cutting Review (`codex/dev-test-logging` vs `main`)

Scope: diff-only review of modified existing files — auth, circle, circle-invitation,
friend, trace, user, config/env, prisma schema + 3 migrations, env files, `.gitignore`,
`package.json`. New files (logging/, realtime/, icon/, etc.) reviewed only where an
in-scope file calls into them.

---

## 1. TL;DR

| # | severity | file:line | description |
|---|----------|-----------|-------------|
| 1 | HIGH | `.env`, `.env.development`, `.env.production`, `.env.test` (tracked tree) | Real JWT `SECRET` and DB credentials committed to git; `main` only tracked `.env.example`. Branch adds 4 secret-bearing env files. |
| 2 | HIGH | `.gitignore` (whole file) | No `.env` ignore rule exists — env files will keep being committed. Branch only changed `logs/` → `/logs/`. |
| 3 | MEDIUM | `src/circle/circle.service.ts:353-373` | `uploadCircleIcon` / `selectCircleIcon` mutate circle state but never call `iconService.invalidateDisplayIconCacheFor`; 30s stale-cache window for any user whose display icons derive from that circle. |
| 4 | MEDIUM | `src/auth/auth.service.ts:283-300` | `me()` `lastOnline` update `.catch` fallback spreads stale `user` plus `displayIcons` but does not re-apply — minor; fine. Real issue: `displayIcons` fetched outside the update means a slow `iconService` call serializes the hot `/auth/me` path. Acceptable but noted. |
| 5 | LOW | `src/trace/trace.service.ts:267-291` | `createTraceCommentNotifications` + per-target broadcast loop runs outside the comment transaction; a failure after commit leaves the comment created but notifications/broadcasts missing. Non-blocking (best-effort notifications), but no error isolation around the loop. |
| 6 | LOW | `src/auth/auth.service.ts:120` | `auth_register_success` business event logged before `issueTokens`; if token issuance throws, a "success" event is already emitted. Cosmetic log accuracy only. |
| 7 | LOW | `prisma/migrations/20260423190000_unified_user_icons/migration.sql:60-64` | Seeded SYSTEM `IconAsset` rows have `imageUrl = NULL`; clients selecting these get a null image. Intentional placeholder, but ship-time content gap. |

No destructive migrations. No schema/migration drift. No broken authorization. No client-trusted identity.

---

## 2. Per-Area Walkthrough

### Auth (`auth.service.ts`, `login.dto.ts`, `register.dto.ts`)
- **DTO validation (Pattern A): OK.** New `platform?` field on both DTOs is `@IsOptional() @IsIn([1,2,5])` with a typed `1 | 2 | 5` union — strict, whitelist-validated. Good.
- **Server-derived identity (Pattern B): OK.** `issueTokens` still derives `userId`/`accountId`/`role` from the looked-up `user` record, not from client input. `platform` only influences the OpenIM imToken binding, not auth identity — safe.
- `me()` now does `Promise.all([findUnique, iconService.getDisplayIconsForUser])`. The `lastOnline` update remains best-effort with a `.catch` that returns the stale user — preserved correctly, `displayIcons` merged in both branches. Functionally correct.
- New `ME_SELECT` fields `vipLevel` / `creditScore` and `SafeUser` type additions are consistent with the schema (both already existed on `User`).
- Business-event logging is gated behind `loggingConfig.businessLogOn` and uses `actorId`/`entityId` — no PII in metadata (only `reason` strings). Login-failure events correctly omit `actorId` when the user is unknown. Good.
- Finding #6: register logs `auth_register_success` before `issueTokens` resolves — log-accuracy nit only.

### Circle (`circle.service.ts`, `circle.controller.ts`, `circle.dto.ts`, `circle.module.ts`)
- **Authorization (Pattern B): OK.** New `assertOwner` does `findFirst({ id, deleted:false })` then `circle.ownerID !== userId → ForbiddenException`. Owner identity comes from `req.user.userId` (JWT), circle owner from DB. Both `uploadCircleIcon` and `selectCircleIcon` call `assertOwner` first. Correct.
- `selectCircleIcon` re-validates the icon asset belongs to SYSTEM or *this* circle (`OR: [SYSTEM, {CIRCLE, circleID}]`) before assigning — prevents cross-circle icon assignment. Good defensive scoping.
- `leaveCircle` now also `deleteMany`s `UserDisplayIcon` for `{userID, circleID}` inside the existing `$transaction` (Pattern C) — correct, keeps display-icon rows consistent with membership.
- `markActivityRead` adds `realtimeService.broadcastCircleUnreadCount(userId)` after the DB write — best-effort broadcast, fine.
- Finding #3: icon upload/select changes `IconAsset` rows and `Circle.currentIconAssetID`. `IconService.getDisplayIconsForUser` caches per-user for 30s. Circle membership (the key for `UserDisplayIcon.circleID`) is unchanged by these ops, so the *display-icon set* itself is unaffected — but the circle-icon **picker** data (`availableIconAssets`, `currentIconUrl`) and any eligibility derived from `IconAsset` are not cache-busted. Self-heals in 30s; MEDIUM, not blocking.
- `CircleDetailDto.availableIconAssets` is optional and response-only — no validation concern.

### Circle-Invitation (`circle-invitation.service.ts`, `.module.ts`)
- Added realtime broadcasts after `respond` / `adminApprove`. Each does a fresh `findUnique` to resolve `applicantID`/`circleID` and broadcasts only when `applicantID` exists — null-safe.
- `broadcastCircleUnreadCount` is awaited; `broadcastCircleInvitationReviewed` is fire-and-forget. Broadcasts run *after* the transaction — best-effort, acceptable. No authorization change (existing verifier/admin checks untouched). OK.

### Friend (`friend.service.ts`, `.module.ts`)
- `sendRequest` refactored to capture the `$transaction` return into `request` so `request.id` can be logged — transaction body unchanged, still atomic (Pattern C preserved).
- `broadcastFriendUnreadUpdates` dedups user IDs (`new Set`, `.filter(Boolean)`) and `Promise.all`s the broadcasts — runs after the transaction commits. Best-effort, fine.
- Business events use `actorId`/`targetId`/`entityId` only — no PII. Block event uses a synthetic `${blockerId}:${targetId}` entityId — acceptable.
- No invariant or authorization change. OK.

### Trace (`trace.service.ts`, `.module.ts`)
- `addComment` now captures `trace` from `requireVisibleTrace` (which enforces PUBLIC / owner / FRIENDS_ONLY visibility — authorization intact) to pass `trace.fromID` to notification creation.
- Finding #5: `createTraceCommentNotifications` + the `Promise.all` broadcast loop run *after* the comment `$transaction` commits. A throw in notification creation would propagate as a 500 to the client even though the comment succeeded, and there is no try/catch isolating best-effort broadcasts. Low severity (notifications are non-critical), but the comment-create response can fail spuriously. Recommend wrapping the post-commit notification/broadcast block in a `.catch` that logs.

### User (`user.service.ts`, `.module.ts`, `public-user.dto.ts`)
- `findOne`/`update`/`remove`/`updateStatus` all now `Promise.all` the Prisma call with `iconService.getDisplayIconsForUser` and merge `displayIcons` into the response. Read-only icon fetch — no transaction concern.
- New `updateBasicProfile` calls `prisma.user.update` directly **without** the `findOne` existence pre-check that `update` does, and without `assertUrlsAreSafe`. If `updateBasicProfile` is reachable from a controller with user-supplied URL fields, it bypasses the URL-safety guard. **Out of in-scope file set to confirm the caller** — flagged for the controller reviewer; within `user.service.ts` itself it is a behavioral divergence worth noting (MEDIUM if wired to untrusted input, LOW if internal-only). `normalizeUpdateInput` still runs, so basic normalization is applied.
- `public-user.dto.ts`: `displayIcons` added with `@Expose() @Type(() => DisplayIconDto)`; `vipLevel`/`creditScore` added to `SelfUserDto` only (not `PublicUserDto`) — correct PII/scope separation, these stay off the public profile.

### Config / Env (`env.validation.ts`, `config.enum.ts`)
- 5 new logging env vars added to the Joi schema. `SLOW_REQUEST_MS` is `Joi.number().integer().min(1).default(1000)`; the `*_LOG_ON` flags are `Joi.boolean()` (no `.required()`, no `.default()`) — they will be `undefined` if unset. Acceptable since `createLoggingConfig` presumably coalesces, but adding `.default(false)` would be safer. LOW.
- `LogEnum` enum mirrors the new keys — consistent.

### Env files & `.gitignore` — see Findings #1 and #2 (HIGH)
- `.env.development`, `.env.test`, `.env.example` add the 5 logging vars (env parity — good, no drift).
- `.env.production` change is whitespace-only (added trailing newline).
- **However:** `.env`, `.env.development`, `.env.production`, `.env.test` are *committed in the branch tree* (verified via `git ls-tree`), whereas `main` tracks only `.env.example`. Each committed file contains a real `SECRET` (JWT signing key) and `postgresql://postgres:postgres@...` DB URLs. `.gitignore` has **no `.env*` rule**. This is a HIGH-severity secret-exposure issue: the JWT secret in `.env.production` is now in git history and must be rotated; `.env*` (except `.env.example`) must be added to `.gitignore` and the files `git rm --cached`.

### `package.json`
- New deps: `ws@^8.20.0` (runtime) and `@types/ws@^8.18.1` (placed under `dependencies`, should be `devDependencies` — LOW). Both are reputable, widely-used, and needed by the new `realtime.gateway` WebSocket code. No supply-chain concern.

---

## 3. schema.prisma vs Migrations — Drift Check

**Verdict: NO DRIFT. Schema and migration SQL are consistent.**

| Migration | Schema counterpart | Match |
|-----------|--------------------|-------|
| `20260422170000_membership_collections` — `ALTER TYPE CoinTxType ADD VALUE 'PURCHASE'`; `CREATE TYPE CollectionType`; `CREATE TABLE UserCollection` + index + FK | `enum CoinTxType { ... PURCHASE }`, `enum CollectionType`, `model UserCollection` with `@@index([userID,type,createdAt])`, `onDelete: Cascade` | ✅ |
| `20260423190000_unified_user_icons` — `CREATE TYPE IconAssetSourceType / UserDisplayIconType / SystemIconKey`; `ALTER Circle ADD currentIconAssetID`; `CREATE TABLE IconAsset`, `UserDisplayIcon`; unique indexes `(userID,systemKey)`, `(userID,circleID)`; FKs | enums + `model IconAsset`, `model UserDisplayIcon`, `Circle.currentIconAssetID` + relations `currentCircleIcon` / `circleIconAssets`; `@@unique([userID,systemKey])`, `@@unique([userID,circleID])` | ✅ FK `onDelete` rules match (Circle.currentIconAssetID → SetNull; IconAsset.circleID → Cascade; IconAsset.createdByID → SetNull; UserDisplayIcon → Cascade) |
| `20260423203000_icon_preferences_initialized` — `ALTER User ADD iconPreferencesInitialized BOOLEAN NOT NULL DEFAULT false` | `User.iconPreferencesInitialized Boolean @default(false)` | ✅ |
| `20260515170000_add_conversation_groups` (not in scope list but present) — `CREATE TABLE ConversationGroup`, `ConversationGroupMembership` + indexes + FKs | `model ConversationGroup`, `model ConversationGroupMembership` | ✅ Only `groupID` has a FK; `conversationID` intentionally has none (conversations live in OpenIM — documented in schema comment). Consistent. |

- **No destructive operations.** All migrations are additive: `ADD VALUE`, `CREATE TYPE`, `CREATE TABLE`, `ADD COLUMN`, `ADD CONSTRAINT`. No `DROP COLUMN` / `DROP TABLE` / `DROP TYPE`. The new `User.iconPreferencesInitialized` column is `NOT NULL DEFAULT false` — safe on a populated table.
- The bulk of the `schema.prisma` diff is `prisma format` whitespace re-alignment of unrelated models (Friend, Note, Tag, Squad, CoinTransaction, etc.) — no semantic change, just noisy diff.
- `ALTER TYPE ... ADD VALUE` on `CoinTxType` cannot run inside a transaction on older Postgres, but Prisma's migration runner handles enum value additions in their own statement — standard, not a concern.

---

## 4. Verified OK

- DTO validation: `LoginDto.platform` / `RegisterDto.platform` strictly whitelisted (`@IsIn([1,2,5])`, optional, typed union).
- Authorization: `CircleService.assertOwner` correctly compares DB `ownerID` to JWT `userId`; `selectCircleIcon` re-scopes icon assets to SYSTEM or own circle.
- `leaveCircle` cleans `UserDisplayIcon` inside the existing transaction — invariant preserved.
- `friend.sendRequest` transaction remains atomic after refactor to capture the return value.
- Trace `addComment` keeps `requireVisibleTrace` visibility enforcement (PUBLIC / owner / FRIENDS_ONLY).
- `SelfUserDto`-only placement of `vipLevel`/`creditScore` — no PII leak to `PublicUserDto`.
- All 4 migrations are additive and match `schema.prisma` exactly — no drift, no data loss.
- Business/security event logging carries IDs only, no passwords/tokens/PII; gated behind config flags.
- `ws` / `@types/ws` are reputable and required by the new realtime gateway.
- Env-var parity across `.env.development` / `.env.test` / `.env.example` for the 5 new logging keys — no env drift in *values*.

---

## 5. Phase Verdict

**NOT merge-ready. Blocking issues present.**

Blocking (must fix before merge):
1. **Finding #1 — committed secrets.** `.env`, `.env.development`, `.env.production`, `.env.test` are committed with a real JWT `SECRET` and DB credentials. `git rm --cached` them, rotate the production JWT secret (it is now in history), and rely on `.env.example` only.
2. **Finding #2 — `.gitignore` has no `.env` rule.** Add `.env` and `.env.*` (with a `!.env.example` exception) so this cannot recur.

Non-blocking but should address:
- #3 stale icon cache on circle icon swap (self-heals in 30s).
- #5 wrap the post-commit trace-notification/broadcast block in a `.catch` so notification failures don't 500 a successful comment.
- `updateBasicProfile` skips `assertUrlsAreSafe` — confirm its controller caller does not accept untrusted URL fields (defer to controller reviewer).
- Move `@types/ws` to `devDependencies`.

The business-logic, schema, and migration changes themselves are sound — additive, non-destructive, no drift, authorization intact. The blockers are purely the committed-secrets / gitignore hygiene problem.
