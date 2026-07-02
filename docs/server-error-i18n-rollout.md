# Server-Error i18n Rollout Plan — remaining throws

_Last updated: 2026-07-02. Companion to the `feat/server-error-i18n` work (PRs circle_be#27, Circle_frontend#39)._

Goal: give every **user-actionable** backend error a stable `errorCode` so the app
localizes it, instead of showing a raw (often Chinese, sometimes English) message.
This is incremental — pick a module, tag it, ship. Nothing here is urgent.

---

## 1. Where we are (2026-07-02)

- **Mechanism is done** (see `src/common/app-error-codes.ts` + `all-exception.filter.ts`; frontend `services/api/errors.ts` + `server-error-codes.ts`). Don't redesign it — just add codes.
- **284** user-facing throws total; **245 tagged** (= **150 distinct codes** across **19 groups**: the earlier set plus `chat-history / collection / icon / like / privacy / user`). Rounds 5–10 have landed, plus the user-actionable tails of call / friend / note / trace / conversation-group / chat-history / privacy / user / like / icon / collection.
- **39 untagged throws remain, and all are skip-by-design** per §2: transient `ServiceUnavailable` (LiveKit / upload / export "not configured" / account-id-gen / temp-chat retry / call membership), session mechanics (`refresh-token` reuse/expiry), webhook & dev guards (`RAW_BODY_REQUIRED`, `idempotency-key header`, `objectKey`/`section`/`reorder` validation, "Invalid timestamp"), internal by-id `User not found` (credit / icon / user / call `normalizeID`), storage-origin security guards (`circle-plaza`, `utils/storage-url` — deliberately un-coded), and the admin-only `friend-report-admin` console. A cross-repo test enforces `APP_ERROR_CODES == SERVER_ERROR_CODES == serverErrors keys (×5 locales)`, incl. an explicit `SERVER_ERROR_CODES == APP_ERROR_CODES` assertion.
- **Display-wiring still owed for 3 modules.** `like`, `icon`, and `collection` screens do **not** yet funnel through `getApiErrorMessage`, so their codes are correct and forward-compatible but won't show localized copy until those screens are wired (route their `catch` through the shared helper). Everything else tagged is already displayed. Newer frontends degrade untagged `ApiError`s to the caller's generic fallback (no raw-message leak), so nothing regresses in the meantime.

### Untagged inventory, by module

| Module | Untagged | FE display funnels through `getApiErrorMessage`? | Notes |
|---|---:|---|---|
| **friend** | 38 | ❌ mostly not (scattered: contacts screens, moments-feed, MessagesScreen) | Highest count. Needs display wiring first. |
| **note** | 30 | ❌ notes screens don't funnel | Many are `NotFound` (low value). Triage. |
| **circle-invitation** | 29 | ✅ likely (discover feature funnels in 6 spots) | Core social flow (join requests / 10-person guarantee). |
| **call** | 29 | ❌ call UI doesn't funnel | Real-time; many surface as toasts/none. Small user-facing subset. |
| **circle-plaza** | 21 | ✅ likely (discover) | Plaza posts / signups. |
| **trace (moments)** | 11 | ✅ likely (discover) | Moments feed. |
| **temp-chat** | 7 | ✅ TempChatsScreen funnels | Cheap. |
| **upload** | 6 | partial | Some already localized frontend-side (round 1). |
| **icon** | 5 | ? | Circle icon / display-icon system. |
| user 4 · privacy 4 · like 4 · conversation-group 4 · chat-history 4 | 20 | mixed | Small tails. |
| **auth** | 4 | ✅ use-auth funnels | Leftover edge cases (change-password/account edges). |
| coin 1 · utils 1 · credit 1 · collection 1 | 4 | mixed | Trivial tail. |
| ~~circle / group / membership~~ | 0 | ✅ | Done. |

### By exception type (whole codebase — value signal)

| Type | Count | Default disposition |
|---|---:|---|
| `NotFoundException` | 89 | **Mostly skip.** Only tag the ones a user directly triggers by input (e.g. "user not found" when adding by account-id). Consider 1–2 shared generic codes rather than one per entity. |
| `BadRequestException` | 77 | Tag the user-actionable validation/business ones; skip dev-guards (e.g. "idempotency-key header is required"). |
| `ForbiddenException` | 50 | **Tag most.** Permission/eligibility failures are exactly what users need to understand. |
| `ConflictException` | 38 | **Tag most.** already-exists / duplicate / wrong-state are user-actionable. |
| `ServiceUnavailableException` | 15 | **Skip.** Transient/infra → generic "try again" fallback is correct. |
| `Unauthorized` 8 · `PayloadTooLarge` 2 · `Gone` 2 | 12 | Case-by-case. |

---

## 2. Triage rule — does a throw deserve a code?

- ✅ **Yes** — a user-actionable business rule: Forbidden / Conflict / specific BadRequest where the user can *do something* about it (top up, pick a higher level, wait, choose a different value).
- 🤔 **Maybe** — `NotFound` the user triggers directly by input. Prefer a small set of shared codes (e.g. `X_USER_NOT_FOUND` per domain) over one per entity.
- ❌ **No** — internal/transient (`ServiceUnavailable`), developer guards (missing header, wrong endpoint), or anything masked as `Internal server error` in prod. The generic caller fallback already covers these.

**Don't blanket-tag all remaining throws.** The rest stay on the generic fallback unless they are user-actionable or a screen bypasses the shared frontend helper.

---

## 3. Proposed rounds (value × cheapness)

Ordered so early rounds are high-value AND cheap (FE already funnels):

- **Round 5 — circle-invitation (29) + temp-chat (7).** Core social flow; discover/messages funnel already → mostly backend + locale keys, little wiring. _Best next round._
- **Round 6 — circle-plaza (21) + trace/moments (11).** Same discover funnel. Triage the not-founds.
- **Round 7 — friend (38).** High value but needs a **display-wiring sub-task first**: audit contacts screens + moments-feed + MessagesScreen add-friend, route their catches through `getApiErrorMessage`, THEN tag. Split into 7a (wire) / 7b (tag).
- **Round 8 — note (30).** Triage-heavy (many not-found); wire notes screens for the few user-actionable ones (empty title, permission).
- **Round 9 — call (29).** Hardest ROI: mostly real-time, few surface a user message. Tag only the handful shown in the call UI (busy / ended / not-allowed).
- **Round 10 — tail cleanup.** auth(4), coin(1), upload(6), icon(5), user(4), privacy(4), like(4), conversation-group(4), chat-history(4), utils/credit/collection(3).

Each round is independently shippable and forward/back-compatible (old client ignores unknown codes; untagged throws still show their message).

---

## 4. Per-round checklist (the reusable recipe)

1. **Pick the module.** List its throws: `grep -rnE "throw new .*Exception" src/<module>`.
2. **Triage** with §2. Decide the code set (reuse existing codes where the meaning matches — e.g. an existing `*_USER_NOT_FOUND`).
3. **Backend:**
   - Add codes to the right group in `src/common/app-error-codes.ts` (SCREAMING_SNAKE_CASE, unique — `app-error-codes.spec.ts` enforces both).
   - Convert throws: `throw new XException('msg')` → `throw new XException({ message: 'msg', errorCode: XErrorCode.Y })`. **Keep the message** (backward compat + existing `toThrow(/…/)` specs).
4. **Frontend:**
   - Add the same code strings to `src/services/api/server-error-codes.ts` (`SERVER_ERROR_CODES`).
   - Add `serverErrors.<CODE>` to **all 5** locales (zh/en/ja/ko/es). Interpolated backend messages → write a **static generic** localized string (params aren't threaded through the envelope).
   - **Display site**: confirm the screen's catch routes through `getApiErrorMessage(err, fallback)`. If it shows a generic/raw message, wire it (like `MemberCenterScreen` / `InviteGroupMembersScreen` did).
5. **Verify:** BE `tsc && jest`; FE `tsc && node --test && jest && expo lint --max-warnings 0`. The contract test fails loudly if the 3 sources drift.
6. **Commit** per repo (`feat(<module>): …` / `feat(i18n): …`), push, PR.

---

## 5. Gotchas

- **Three-way sync is mandatory.** BE catalog, FE whitelist, and all 5 locale key sets must match exactly — the contract test in `test/api-error-localization.test.js` guards it (it reads `../circle_be`, skipped when the sibling isn't present so frontend-only CI stays green).
- **Never drop the backend `message`.** It's the human-readable default for old clients / non-app consumers / existing specs. `errorCode` is additive.
- **Unknown code → generic fallback, not the backend message** (frontend `getApiErrorMessage` intentionally won't surface an un-whitelisted code's text). So shipping a backend code before the frontend whitelist+locale entry = users see the generic fallback until the FE catches up. Ship both together.
- **Interpolated messages lose specifics** (e.g. "VIP 3+ required" → "A higher VIP level is required"). Acceptable; if a number is truly needed, that requires threading interpolation params through the envelope — a separate mechanism change, not worth it for a one-off.
- **Don't tag the friend flow before wiring its display** — the codes would land but users still wouldn't see localized text (the screens don't funnel yet).

---

## 6. Definition of done (per code)

- [ ] In `app-error-codes.ts`, unique + SCREAMING_SNAKE_CASE
- [ ] Throw uses `{ message, errorCode }`, message unchanged
- [ ] In FE `SERVER_ERROR_CODES`
- [ ] `serverErrors.<CODE>` in all 5 locales
- [ ] Display screen funnels through `getApiErrorMessage` (or wired this round)
- [ ] BE + FE test suites + contract test green
