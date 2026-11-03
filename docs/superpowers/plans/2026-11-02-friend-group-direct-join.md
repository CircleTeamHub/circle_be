# Friend Group Direct Join Implementation Plan

> **For agentic workers:** Execute inline using systematic debugging, test-driven development, and verification before completion. This scoped plan is authorized by the parent task; do not commit, deploy, or apply migrations.

**Goal:** During initial standalone group creation, directly join only accepted friends who explicitly enabled `allowFriendGroupDirectJoin`; invite every other eligible friend.

**Architecture:** Add one default-false account privacy boolean, leaving `groupInvitePermission` unchanged. Read consent together with invitation authorization under existing relationship locks, atomically create seats and JOINED admissions for opted-in friends, and retain INVITED admissions for others. Use existing delivery outbox for durable joined broadcasts/notifications and existing transaction-aware group event recording for join logs.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Expo/React Native, Jest.

## Global Constraints

- Preserve existing uncommitted changes; no changes to subsequent invitations, QR joins, circle admission, or approval policy.
- Friendship, `EVERYONE`, and missing privacy rows never imply direct-join consent.
- Both directions of blocking and disabled invitation permission reject creation before any group writes.
- Parent owns all locale files. New frontend label key: `settingsDetails.privacy.allowFriendGroupDirectJoin`.
- Coordinate the single additive schema field with the sticker agent; use a separate migration.

### Task 1: Account privacy consent

**Files:** `prisma/schema.prisma`; `prisma/migrations/20261102190000_friend_group_direct_join/migration.sql`; `src/privacy/privacy-settings.dto.ts`; `src/privacy/privacy-settings.service.ts`; their existing `.spec.ts` files.

- [x] Add regressions asserting missing/legacy privacy rows return false, explicit true/false persists under the existing relationship lock, and null/string booleans fail DTO validation before persistence.
- [x] Run `npm test -- --runInBand src/privacy/privacy-settings.service.spec.ts src/privacy/privacy-settings.dto.spec.ts` and observe the missing default/contract failures.
- [x] Add `allowFriendGroupDirectJoin Boolean @default(false)` and `ALTER TABLE "UserPrivacySetting" ADD COLUMN "allowFriendGroupDirectJoin" BOOLEAN NOT NULL DEFAULT false;` only. Add DTO boolean validation with a raw-value transform matching existing explicit-consent booleans; expose default and stored value through `PrivacySettingsService`.
- [x] Regenerate the Prisma client without applying migrations; rerun focused privacy tests.

### Task 2: Initial group creation

**Files:** `src/chat/chat.service.ts`; `src/chat/chat-group-conversation.spec.ts`; `test/postgres/chat-send-group-invite-batch.pg-spec.ts`.

- [x] Add mixed-consent regression: only `f1` with explicit true has a seat and JOINED admission/delivery; `f2` false and `f3` missing remain INVITED. Assert atomic join log and no invite card delivery for `f1`.
- [x] Add regressions for all-direct/no-empty-write behavior, true consent with NONE/nonfriend/bilateral block denial, and failed log/outbox writes rejecting creation with no post-commit broadcasts.
- [x] Run the standalone group tests and observe mixed-consent and blocking failures before production changes.
- [x] Return opted-in IDs from the existing boundary authorization query; add bilateral block check there. Create owner/direct seats in the new-group nested create. Batch all admissions with JOINED/INVITED status, acceptance/decision metadata only for direct joins, and corresponding delivery events. Record joined targets with `recordInTx` inside the creation transaction. Keep the existing owner broadcast and group-created notice.
- [x] Update the real PostgreSQL regression to assert mixed seats/admissions/deliveries and rollback when outbox insertion fails, if an isolated test database is configured.
- [x] Run focused group/admission tests, backend `tsc --noEmit`, no-fix changed-file ESLint, and `git diff --check`.

### Task 3: Privacy toggle

**Files in frontend worktree:** `src/services/api/privacy.ts`; `src/features/profile/screens/PrivacySettingsScreen.tsx`; `src/features/profile/screens/PrivacySettingsScreen.spec.tsx`; `test/privacy-api.test.js`.

- [x] Add UI regression for legacy/missing consent showing false, explicit true loading and saving, and failed saves restoring prior value. Add API boundary regression rejecting nonboolean values while accepting old servers without the new property.
- [x] Run focused frontend tests and observe missing-toggle/validation failures.
- [x] Add optional API field for rolling deployment, validate it once at the API boundary, and add default-false settings toggle beside group invitation permission using the existing save/cache/rollback path.
- [x] Run focused Jest/API tests, frontend typecheck, no-fix changed-file ESLint, and diff-check. Verify all temporary commands/processes exited.

## Verification evidence

- RED observed: mixed-consent creation had only the owner seat; blocked friends were accepted; missing privacy defaults/DTO fields and missing UI toggle failed; invalid API consent types were accepted.
- GREEN: 148 focused backend tests across group creation, admissions, and privacy; 16 focused frontend behavior tests; 2 privacy API tests.
- Backend TypeScript passed after the private Prisma client was generated with both concurrent schema additions. Parent independently completed the full frontend TypeScript check after the sticker module was created.
- PostgreSQL regression suite compiles and reports 6 skipped tests because POSTGRES_TEST_DATABASE_URL is absent; mixed persistence and real transaction rollback were not executed against a database.
- Frontend changed-file no-fix ESLint passed. Backend no-fix ESLint exited 0 with no errors and five pre-existing warnings at unrelated `chat.service.ts` lines 550-553 and 617.
- No migrations applied, deployments, or commits. Locale key is supplied by parent in all five languages.
