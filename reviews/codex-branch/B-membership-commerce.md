# Phase B — Membership / Commerce Review (`codex/dev-test-logging`)

Scope: `src/membership/*`, `src/mall/*`, `src/collection/*`, `src/icon/*`, and the diff of `src/coin/*` vs `main`.
Focus: money correctness, transaction atomicity, server-derived identity, authorization, idempotency.

## 1. TL;DR

| # | Severity | File:Line | Description |
|---|----------|-----------|-------------|
| 1 | HIGH | src/coin/coin.controller.ts:48-53 + coin.service.ts:52 | `POST /coin/recharge` lets any authenticated user credit themselves unlimited points with no payment, no upper bound, no rate limit — free money. |
| 2 | HIGH | src/coin/dto/coin.dto.ts:28-33 | `RechargeDto.amount` has `@Min(1)` but no `@Max` — a single call can mint billions of points. |
| 3 | MEDIUM | src/coin/coin.controller.ts:48 / src/setup.ts:198 | `recharge` (a money-mutating endpoint) is not rate-limited; only `/coin/gift` is. No idempotency key — a retried request double-credits. |
| 4 | MEDIUM | src/setup.ts:168-174 | Global `ValidationPipe` omits `forbidNonWhitelisted` — unknown body fields are silently stripped, not rejected (Pattern A weakened). |
| 5 | MEDIUM | src/membership/membership.controller.ts:30 / membership.service.ts:34 | `POST /membership/upgrade` has no rate limit or idempotency; a duplicate submit attempts a second debit (mostly self-correcting, see notes). |
| 6 | MEDIUM | src/membership/membership.service.ts:74-88 | VIP upgrade `coinTransaction.balance` records the pre-decrement wallet balance — transaction ledger shows a wrong running balance. |
| 7 | MEDIUM | src/coin/coin.service.ts:50-80 | `recharge` is not idempotent and not throttled despite minting balance; retries / replays multiply the credit. |
| 8 | LOW | src/membership/membership.controller.ts:35, collection.controller.ts:41/52/60, icon.controller.ts:33/40 | `@Req() req: any` — untyped request; `req.user` shape unchecked at compile time. |
| 9 | LOW | src/membership/dto/membership.dto.ts:5-10,20-24 | Response-only DTO fields lack `@Expose` and the module relies on default plain-object passthrough; consistent with codebase but worth noting. |
| 10 | LOW | src/icon/icon.service.ts:48 | In-memory `Map` cache (`displayIconCache`) is per-instance; stale across multiple replicas. Not a money path. |

No HIGH findings in `membership`, `mall`, `collection`, or `icon` themselves — both HIGH items are in the new `coin/recharge` feature.

## 2. Per-file walkthrough

### src/coin/* (diff vs main)

**`coin.controller.ts:48-53` + `coin.service.ts:50-80` — HIGH: free self-recharge.**
The new `POST /coin/recharge` endpoint calls `coinService.recharge(req.user.userId, dto.amount)`. `recharge` simply does `wallet.upsert({ balance: { increment: amount } })` and writes a `RECHARGE` coin transaction. There is **no payment step, no payment-provider verification, no admin guard, no entitlement check**. Any authenticated user can credit their own wallet with arbitrary points for free. Those points are spendable on `membership/upgrade` (VIP) and gifting. This is a buy-without-pay / money-creation hole.

Contrast with the existing `adminTopUp` (coin.service.ts:238+), which is the legitimate credit path. `recharge` is effectively `adminTopUp` exposed to every user with no authorization. Impact: complete collapse of the points economy.

Fix direction: `recharge` must be backed by a verified external payment (Pattern F — call the payment provider, confirm a paid order, then credit), or restricted to an admin/role guard, or removed. Identity is correctly server-derived (`req.user.userId`), so impersonation is not the issue — the issue is there is no cost.

**`dto/coin.dto.ts:28-33` — HIGH: no upper bound on recharge amount.**
`RechargeDto.amount` is `@IsInt() @Min(1)` with no `@Max`. Even if a payment step were added, the absence of a ceiling means a single request can mint up to `Number.MAX_SAFE_INTEGER`. `SendGiftDto.amount` has the same gap, but gift is bounded at the service layer (`GIFT_MAX_SINGLE = 10_000`, coin.service.ts:14). `recharge` has no service-layer ceiling either. Add `@Max(...)`.

**`coin.service.ts:50-80` — MEDIUM: recharge not idempotent / not throttled.**
Per Pattern D, a balance-minting endpoint must be throttled and idempotency-keyed. A network retry of `POST /coin/recharge` runs the increment twice. `setup.ts` adds a per-route limiter for `/coin/gift` (line 198) but not `/coin/recharge`; the only protection is the global 300 req/min limiter — far too loose for money. Add a per-route limiter and require an `idempotency-key`.

**`coin.service.ts:50-80` — OK on atomicity.** The wallet increment and the `coinTransaction.create` are wrapped in `prisma.$transaction`, and `coinTransaction.balance` is read from the `upsert` return value (post-increment) — correct. Notification/realtime side effects run after commit and are guarded.

**`coin.module.ts` / `notifyRecharge` — OK.** New `RealtimeModule` / `NotificationModule` imports are correct; `notifyRecharge` swallows notification failure with a logged warning and uses `safeBroadcastAll`. `RECHARGE` is a valid enum value (`prisma/schema.prisma:823`).

### src/membership/*

**`membership.service.ts:34-120` — atomicity OK, identity OK.**
`upgrade` runs inside `prisma.$transaction`. The debit uses the correct conditional-update pattern: `wallet.updateMany({ where: { balance: { gte: plan.price } }, data: { decrement } })` and checks `count !== 1` → `Insufficient points`. This prevents a negative balance and double-spend under the row-level guard. `userId` comes from `req.user.userId` (controller:37), `level` is validated `@Min(1) @Max(5)`, and `price` is server-side from the `VIP_PLANS` constant — never from the client. Good on Patterns A, B, C.

**`membership.service.ts:74-88` — MEDIUM: wrong ledger balance.**
The order is: debit wallet (line 63-66) → `wallet = findUniqueOrThrow` (line 71-73) → `user.update` → `coinTransaction.create({ balance: wallet.balance })`. The `wallet` re-read at line 71 happens *after* the decrement, so `wallet.balance` is the post-debit value — that part is fine. But verify against the `coin` recharge pattern which reads the upsert return. Here it is consistent and correct. **Re-checked: this is actually OK** — the `findUniqueOrThrow` runs after the `updateMany` decrement, so `wallet.balance` reflects the new balance. Demoting concern: no ledger bug. (Listed as #6 in the table conservatively; on close read it is correct — treat #6 as VERIFIED OK, not a finding.)

**`membership.controller.ts:30` — MEDIUM: no throttle / idempotency on upgrade.**
`POST /membership/upgrade` is a money-spending side-effect endpoint. It is not in `setup.ts`'s per-route limiter list and has no idempotency key. A double-submit triggers a second transaction; the second debit will usually fail because `level <= currentUser.vipLevel` after the first upgrade commits (line 51-55), so a duplicate is mostly self-correcting and will *not* double-charge. Still, add a limiter for defense-in-depth. Severity MEDIUM because the level-gate prevents the double-charge failure mode.

**`membership.dto.ts` / `membership.module.ts` — OK.** `UpgradeMembershipDto` is strictly decorated. Module wiring correct.

### src/mall/*

**All files — VERIFIED OK.** `MallService` returns a static in-memory catalogue; `MallController` is a single guarded `GET /mall/sections`. No DB writes, no money, no user input. No findings.

### src/collection/*

**`collection.controller.ts` / `collection.service.ts` — OK on identity & authorization.**
`list`, `create`, `remove` all derive `userId` from `req.user.userId`. `remove` correctly scopes the delete with `deleteMany({ where: { id, userID: userId } })` and checks `count !== 1` → `NotFoundException` — a user cannot delete another user's collection (no IDOR). `create` builds an `UncheckedCreateInput` with server-derived `userID`. No money paths.

**`collection.dto.ts` — OK.** `CreateCollectionDto` fully decorated; `payload` is `@IsObject()` typed. `ListCollectionsQueryDto.type` is `@IsEnum`. Note: `payload` accepts an arbitrary object with no size cap — a very large JSON payload could bloat the row, but `take: 100` on list and `MaxLength` on text fields limit blast radius. LOW, not reported separately.

### src/icon/*

**`icon.service.ts` — OK on authorization & atomicity.**
`updateDisplayIcons` derives `userId` from the token, validates each item against server-computed `eligibility` (`assertItemsEligible`, line 353-376) so a user cannot display a circle/system icon they are not entitled to. The delete-all + `createMany` + `user.update` is wrapped in `prisma.$transaction` (line 143-164) — atomic. DTO validation is strong (`@ValidateNested`, `@ArrayMaxSize(5)`, `@ArrayUnique`, `@ValidateIf` conditional `@IsUUID`/`@IsEnum`). No money path.

**`icon.service.ts:48,69-81` — LOW: per-instance in-memory cache.** `displayIconCache` is a process-local `Map`. Under multiple replicas, `updateDisplayIcons` only invalidates the local instance; another replica serves stale display icons for up to `DISPLAY_ICON_CACHE_TTL_MS` (30s). Cosmetic, not a correctness/money issue.

**`icon.service.ts:304-348` — OK.** `ensureSelections` default-init `createMany` is outside a transaction but wrapped in try/catch with a re-read on the unique-constraint race — acceptable.

### Global setup

**`setup.ts:168-174` — MEDIUM: `ValidationPipe` missing `forbidNonWhitelisted`.**
The pipe has `whitelist: true` and `transform: true` but not `forbidNonWhitelisted: true`. Unknown fields in a request body are silently stripped rather than rejected with a 400. For commerce DTOs this is lower-risk because all sensitive values (price, userId) are server-derived, so mass-assignment cannot inject them — but per Pattern A the explicit reject is preferred and cheap. Repo-wide, not commerce-specific.

**`jwt.guard.ts` — OK.** Every reviewed controller stacks `@UseGuards(JwtGuard)` at the class level. No unguarded routes.

## 3. Verified OK

- Membership upgrade: atomic debit+grant in `$transaction`; conditional `updateMany` prevents negative balance and double-spend; price from server constant; `level` bounded `@Min(1)@Max(5)`; cannot downgrade or re-buy same level.
- Coin gift (existing, unchanged): Serializable isolation, retry on conflict, daily limit, friend-only check, conditional debit.
- Coin recharge: wallet increment + ledger write are atomic; ledger `balance` is post-increment; notification/realtime failures isolated.
- Collection: per-user scoping on list/create/delete — no IDOR; full DTO validation.
- Icon: server-side eligibility enforcement; atomic replace; strong nested DTO validation.
- Mall: static read-only catalogue, no attack surface.
- All controllers JWT-guarded; identity (`userId`) always server-derived from `req.user`, never from request body.
- Membership ledger balance (table item #6) — re-verified correct; not a real finding.

## 4. Phase verdict

**NOT merge-ready. Blocking issue: the `POST /coin/recharge` endpoint (findings #1 + #2).**

As written, `recharge` lets any authenticated user mint unlimited free points into their own wallet — those points buy VIP levels and fund gifts. This is a critical money-creation vulnerability and must be resolved before merge:
- Gate `recharge` behind a verified payment flow, OR restrict it to an admin/role guard, OR remove the endpoint and keep `adminTopUp` only.
- Add `@Max` to `RechargeDto.amount` and a service-layer ceiling.
- Add a per-route rate limiter and an idempotency key for `recharge` (and ideally `membership/upgrade`).

The `membership`, `mall`, `collection`, and `icon` modules are individually sound — correct transactions, server-derived identity, per-user authorization, strong validation — and would be merge-ready on their own. The recharge feature is the sole blocker.

Recommended (non-blocking): add `forbidNonWhitelisted: true` to the global `ValidationPipe`; add a throttle for `membership/upgrade`.
