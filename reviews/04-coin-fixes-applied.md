# Phase 3 — Fixes Applied

> Companion to [`04-coin.md`](./04-coin.md).
> **Verification**: `npx tsc --noEmit` 0 errors · `jest` 28 suites / **167 tests pass** (157 + 10 new).
> Scope rule: fix everything **code-only, non-contract-breaking, no migration**. Migration / product-decision / contract items deferred.

---

## ✅ Applied (5 findings + tests)

| # | Sev | Location | Change |
|---|---|---|---|
| 3 | MED | `coin.service.ts` `getWallet` | Replaced findUnique-then-create with a single race-safe `wallet.upsert` — concurrent first access can no longer both insert and trip the `Wallet.userID` unique constraint |
| 4 | MED | `coin.service.ts` `sendGift` | Replaced the two `Promise.all` blocks inside the `$transaction` callback with sequential `await`s — Prisma interactive transactions run on one connection; concurrent queries are an anti-pattern |
| 5 | MED | `coin.service.ts` `adminTopUp` | Now validates the target user exists and is `ACTIVE` (→ `NotFoundException` instead of a raw FK `P2003`), and caps a single top-up at `MAX_ADMIN_TOPUP = 1_000_000` (fat-finger / Int-overflow guard) |
| 8 | LOW | `coin.controller.ts` | 3× `@Req() req: any` → `RequestWithUser` |
| 10 | LOW | `coin.dto.ts` `SendGiftDto.message` | Added `@Matches(/^[^<>]*$/)` — the gift message is shown in the recipient's transaction history; angle brackets are now rejected so it cannot smuggle HTML/script markup |
| 13 | LOW | `coin.dto.ts` `CoinTransactionDto.type` | `string` → `CoinTxType` enum; `@ApiProperty({ enum })` so Swagger lists the valid values |

### Tests (10 new, `coin.service.spec.ts`)

The money module had **no happy-path test** before. Added:
- `sends a gift: debits sender, credits recipient, records gift + 2 txs` (the missing happy path)
- `rejects gifting yourself before any DB work`
- `rejects a single gift above the per-gift cap`
- `rejects a gift to a non-friend`
- `rejects a gift that would exceed the daily limit`
- `adminTopUp rejects a non-positive amount`
- `adminTopUp rejects an amount above the cap` (verifies #5)
- `adminTopUp rejects a missing target user` (verifies #5)
- `adminTopUp credits the wallet and records a RECHARGE tx`
- `getWallet upserts so concurrent first access cannot collide` (verifies #3)

Extended the spec's `wallet` prisma mock with `upsert`.

---

## ⏸️ Deferred — full inventory of unfixed Phase 3 findings

### HIGH — deferred, needs migration or a product decision

| # | Sev | Why deferred |
|---|---|---|
| 1 | **HIGH** | `sendGift` has no idempotency key → a client retry double-charges. The correct fix needs a `CoinGift.idempotencyKey String? @unique` column (migration) + an `Idempotency-Key` header on `POST /coin/gift` + catch-P2002-return-cached-result. That is a schema migration plus an API addition — must be a dedicated change, not a code-only patch. **This is the top blocker for the coin feature going live and should be the next coin work item.** |
| 2 | **HIGH** | `adminTopUp` is dead code with no route — and it is the *only* credit path, so no coins can enter the system. Wiring it up (`@Post('admin/topup')` + `AdminGuard`) vs. integrating a real payment provider is a product/architecture decision. The service method is now *correct* (see #5) and ready to be wired, but choosing the mechanism is out of scope for a bug-fix pass |

### Deferred — API-contract / frontend coordination

| # | Sev | Why deferred |
|---|---|---|
| 7 | MED | `getTransactions` is hard-capped at 50 rows with no cursor. Adding pagination changes the response and should be done consistently with the other list endpoints (friend Phase 2 #4, etc.) in one frontend-coordinated pass |

### Deferred — low value

| # | Item |
|---|---|
| 9 | `balance` is `Int` (~2.1e9 ceiling); overflow is unreachable under the current `GIFT`/`TOPUP` caps. A `BigInt` migration is disproportionate right now — revisit if the economy scales |
| 11 | recipient `ACTIVE` check is pre-transaction; a ban landing in the µs-wide window between the check and the transaction still lets the gift through. Negligible; re-checking inside the Serializable txn adds a query to the hot path |
| 12 | `adminTopUp` will need `@UseGuards(JwtGuard, AdminGuard)` — only actionable once #2's route decision is made |

---

## 🚨 Required follow-up actions (user)

1. **#1 (idempotency) and #2 (recharge path) are both HIGH and both block the coin feature.** Until they are resolved the module is "correct arithmetic that can double-charge and that nobody can fund." Recommend a dedicated coin PR: add `CoinGift.idempotencyKey @unique`, require the header, and decide the recharge mechanism (admin route vs payment).
2. Bundle `CoinGift.idempotencyKey` into the same migration as the deferred friend-module constraints if convenient.

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 28 passed, 28 total
Tests:       167 passed, 167 total      (was 157 before this patch)
```
