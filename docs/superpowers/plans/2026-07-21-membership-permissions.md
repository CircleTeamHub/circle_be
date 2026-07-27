# Membership Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend source of truth and enforcement for four paid membership tiers, then expose stable contracts for the mobile app.

**Architecture:** A pure catalog and dependency-safe `MembershipPolicyModule` define plans, resolve effective membership, and provide transaction-aware quota assertions. `MembershipModule` imports that policy layer and owns read APIs, idempotent admin grants, and post-commit notifications. Feature services import only `MembershipPolicyModule`, preventing a Realtime/Membership cycle, and enforce limits in authoritative transactions.

**Tech Stack:** NestJS 11, Prisma 7, PostgreSQL, class-validator, Jest

---

### Task 1: Persistence, catalog, and effective membership policy

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260722000000_membership_permissions/migration.sql`
- Create: `src/membership/membership.catalog.ts`
- Create: `src/membership/membership.catalog.spec.ts`
- Create: `src/membership/membership-policy.service.ts`
- Create: `src/membership/membership-policy.service.spec.ts`
- Create: `src/membership/membership-policy.module.ts`
- Modify: `src/membership/membership.module.ts`
- Create: `docs/operations/membership-rollout.md`
- Modify: `deploy/release-deploy.sh`
- Modify: `test/release-deploy.spec.sh`
- Modify: `scripts/release-hardening.test.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `DEPLOY.md`
- Create: `deploy/REQUIRES_IRREVERSIBLE_MIGRATION`
- Modify: `scripts/set-vip.mjs`
- Modify: `scripts/grant-all-badges.js`
- Modify: `scripts/seed-test-data.js`
- Modify: `docs/TEST_ACCOUNTS.md`

- [ ] Write failing tests for all regular and paid-tier actual/display entitlements, excluded features, legacy level mapping, expiration behavior, UTC month-end/leap-year arithmetic, and sorted user-lock keys.
- [ ] Run the two focused specs and verify the expected missing-module failures.
- [ ] Add `vipExpiresAt`, grant audit, one-time benefit grant models, relations, indexes, history normalization (`vipLevel > 4 -> 4`, circle threshold `<=0 -> null`, `>4 -> 4`), and final database constraints in a formal Prisma migration; run Prisma generate.
- [ ] Retire direct VIP writes in operational/test scripts and normalize fixtures to 0-4.
- [ ] Add an explicit irreversible-migration release flag that requires downtime mode. Before migration success, failures may restore the old version; after success, startup/health/proxy/state/smoke failures must stay in maintenance until a forward fix, unless the database backup is restored first. Cover every branch in shell and release-hardening tests and update workflow inputs plus deployment documentation.
- [ ] Add a repository marker for the membership contract migration. Tag-push deployment must fail closed when the marker exists; manual dispatch must require both downtime and irreversible confirmations before any server action. Test tag-push, incomplete manual input, and valid manual dispatch paths; document marker removal only in a later successfully deployed version.
- [ ] Document the membership maintenance-window rollout, backup sequence, verification, and rollback floor.
- [ ] Implement the typed catalog plus pure effective-level resolver.
- [ ] Implement policy reads and reusable quota exceptions without business-service mutations.
- [ ] Re-run focused specs and typecheck.

### Task 2: Idempotent customer-service grants and membership APIs

**Files:**
- Modify: `src/membership/dto/membership.dto.ts`
- Create: `src/membership/membership-admin.controller.ts`
- Create: `src/membership/membership-admin.controller.spec.ts`
- Create: `src/membership/membership-admin.service.ts`
- Create: `src/membership/membership-admin.service.spec.ts`
- Modify: `src/membership/membership.controller.ts`
- Modify: `src/membership/membership.service.ts`
- Modify: `src/membership/membership.service.spec.ts`
- Modify: `src/membership/membership.module.ts`
- Modify: `src/common/app-error-codes.ts`

- [ ] Write failing tests for four returned plans, removal of points exchange, `/membership/me`, admin guards, grant DTO validation, activation, upgrade, expiry calculation, idempotency, concurrency, audit rows, and one-time fancy-number benefit grants.
- [ ] Add an explicit replay test proving repeated idempotency keys do not repeat cache invalidation, realtime events, or notifications.
- [ ] Implement read APIs and the admin-only idempotent grant transaction.
- [ ] Verify no HTTP endpoint, script, or seed path can still create unaudited memberships after rollout phase one.
- [ ] Keep notifications/realtime after commit and verify side-effect failures do not falsify grant failure.
- [ ] Run Prisma generate, focused tests, and build.

### Task 3: Circle creation and membership quotas

**Files:**
- Modify: `src/circle/circle.module.ts`
- Modify: `src/circle/circle.service.ts`
- Modify: `src/circle/circle.service.spec.ts`
- Modify: `src/circle/dto/circle.dto.ts`
- Modify: `src/circle-invitation/circle-invitation.module.ts`
- Modify: `src/circle-invitation/circle-invitation.service.ts`
- Modify: `src/circle-invitation/circle-invitation.service.spec.ts`
- Modify: `src/group/group.module.ts`
- Modify: `src/group/group.service.ts`
- Modify: `src/group/group.service.spec.ts`
- Create: `src/circle/circle-admission-policy.ts`
- Create: `src/circle/circle-admission-policy.spec.ts`

- [ ] Write failing tests for regular-user creation denial, per-tier created/joined/member limits, default finite maxMembers, creator restriction ceiling, final membership/credit/fancy admission recheck, direct-invite recheck, atomic batches, and same-user concurrent joins into different circles.
- [ ] Enforce create quotas in a serializable user-locked transaction containing circle and owner membership writes.
- [ ] Enforce joined-group quotas and current circle restrictions in every activation path, including reviewed applications and direct group invitations; acquire sorted global user locks for batches before counting.
- [ ] Preserve soft degradation and existing circle capacity behavior.
- [ ] Run focused circle, invitation, and group specs.

### Task 4: Note storage quota

**Files:**
- Modify: `src/note/note.module.ts`
- Modify: `src/note/note.service.ts`
- Modify: `src/note/note.service.spec.ts`
- Modify: `src/common/app-error-codes.ts`

- [ ] Write failing tests for regular/paid limits, soft-deleted capacity, create-note enforcement, collect-note enforcement, duplicate collection idempotency, and concurrent boundary writes.
- [ ] Add one helper used by both note creation paths; each caller must use a Serializable transaction and the global user advisory lock before count plus write.
- [ ] Run the focused note spec and confirm existing note behavior remains green.

### Task 5: City filters, VIP restrictions, badges, and profile compatibility

**Files:**
- Modify: `src/circle-plaza/circle-plaza.module.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts`
- Modify: `src/circle-plaza/dto/circle-plaza.dto.ts`
- Modify: `src/circle-plaza/circle-plaza.controller.ts`
- Modify: `src/circle-plaza/circle-plaza.controller.spec.ts`
- Modify: `src/circle/circle.service.ts`
- Modify: `src/circle-invitation/circle-invitation.service.ts`
- Modify: `src/icon/icon-badges.ts`
- Modify: `src/icon/icon.service.ts`
- Modify: `src/icon/icon.service.spec.ts`
- Modify: `src/auth/auth.service.ts`
- Modify: `src/auth/auth.module.ts`
- Modify: `src/auth/__test__/auth.service.spec.ts`
- Modify: `src/user/user.select.ts`
- Modify: `src/user/dto/public-user.dto.ts`
- Modify: `src/user/user.service.ts`
- Modify: `src/user/user.service.spec.ts`
- Modify: `src/icon/icon.module.ts`
- Modify: `src/realtime/realtime.service.ts`
- Modify: `src/realtime/realtime.service.spec.ts`
- Modify: `src/realtime/realtime.module.ts`
- Modify: `src/user/user.module.ts`
- Modify: `src/user/dto/public-user.dto.spec.ts`
- Modify: `src/mall/mall.service.ts`
- Modify: `src/mall/mall.service.spec.ts`

- [ ] Write failing tests for per-tier city counts, the body-based 1000-city search contract, absolute input bounds, expired membership restrictions, four badge levels/titles, legacy VIP5 mapping, effective `/auth/me` and realtime membership, cache behavior across the exact expiry instant, public/plaza name-color appearance, and serializer preservation of the nested appearance object.
- [ ] Add a validated body-based feed search endpoint while retaining the legacy GET endpoint; apply effective membership to all circle/plaza restriction decisions and icon eligibility.
- [ ] Import `MembershipPolicyModule` in every DI consumer module, clamp membership/profile/icon cache lifetime to expiry, and return `vipExpiresAt`, effective `vipLevel`, and serialized public membership appearance without exposing audit internals.
- [ ] Change mall copy/data from “会员充值” to a non-transactional “会员服务” entry that routes to the membership page.
- [ ] Run focused specs and API error-code parity checks.

### Task 6: Backend verification

**Files:**
- Create: `test/membership-permissions.e2e-spec.ts`
- Modify only other files required by failures introduced by this feature.

- [ ] Run `npm run build`.
- [ ] Run focused lint without allowing auto-fix to alter unrelated files, then inspect changes.
- [ ] Run `npm test -- --runInBand`.
- [ ] Add PostgreSQL-backed e2e coverage for grant idempotency, advisory-lock quota boundaries, atomic batch failure, and note create/collect limits; run it when database prerequisites are available and report clearly when unavailable.
- [ ] Run `git diff --check`, inspect the migration, and perform final spec and production-readiness reviews.
- [ ] Verify the formal migration is transactional, succeeds on representative legacy data, appears in normal `prisma migrate deploy`/fresh bootstrap state, and enforces invalid user-level and circle-threshold rejection; verify the documented maintenance procedure never overlaps old and new writers.
- [ ] Run release shell tests proving migration failure restores the old version but every failure after a successful irreversible migration refuses automatic old-binary rollback.
- [ ] Verify the marked release cannot deploy from a tag push and can deploy only through a fully confirmed manual dispatch.
