# Avatar Frame Wardrobe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-device avatar-frame wardrobe with cumulative membership unlocks, audited administrator grants, explicit equip/unequip, mobile detail pages, and admin controls.

**Architecture:** The NestJS backend owns the frame catalog, entitlement merge, continuous-selection deadline, and effective public appearance. The Expo client consumes resolved appearance instead of deriving frames from VIP level, while the React admin adds grant/revoke controls to user detail. Existing local diamond/super PNG assets are selected by stable catalog keys.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Jest, Expo Router/React Native, Zustand, Node test/Jest, React/Vite/Ant Design, TanStack Query, Vitest.

---

### Task 1: Persist the catalog, grants, and explicit selection

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260729120000_avatar_frame_wardrobe/migration.sql`
- Create: `src/avatar-frame/avatar-frame-migration.spec.ts`

- [ ] **Step 1: Write the failing migration contract test**

Assert the schema/migration contains `AvatarFrameAsset`, `UserAvatarFrameGrant`, both selection columns, foreign keys, grant idempotency uniqueness, useful indexes, and deterministic diamond/super seed keys.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `npx jest src/avatar-frame/avatar-frame-migration.spec.ts --runInBand`

Expected: FAIL because the migration and models do not exist.

- [ ] **Step 3: Add Prisma models and SQL migration**

Add the two models, enums/relations as needed, `selectedAvatarFrameID`, and `selectedAvatarFrameExpiresAt`. Seed `membership-diamond` at minimum level 3 and `membership-super` at level 4. Backfill currently effective eligible users to the highest frame without overwriting ordinary users; copy each finite member's current `vipExpiresAt` into `selectedAvatarFrameExpiresAt`, and use `null` only for lifetime memberships.

- [ ] **Step 4: Generate the Prisma client and run the migration test**

Run: `npm run prisma:generate && npx jest src/avatar-frame/avatar-frame-migration.spec.ts --runInBand`

Expected: PASS.

### Task 2: Implement the entitlement resolver and user wardrobe API

**Files:**
- Create: `src/avatar-frame/avatar-frame.module.ts`
- Create: `src/avatar-frame/avatar-frame.service.ts`
- Create: `src/avatar-frame/avatar-frame.controller.ts`
- Create: `src/avatar-frame/dto/avatar-frame.dto.ts`
- Create: `src/avatar-frame/avatar-frame.service.spec.ts`
- Create: `src/avatar-frame/avatar-frame.controller.spec.ts`
- Modify: `src/app.module.ts`
- Modify: `src/membership/membership.module.ts`
- Modify: `src/membership/membership-admin.service.ts`
- Modify: `src/membership/membership-admin.service.spec.ts`
- Modify: `src/common/app-error-codes.ts`
- Modify: `src/common/app-error-codes.spec.ts`

- [ ] **Step 1: Write failing resolver tests**

Cover cumulative membership unlocks, active/inactive catalog entries, permanent/finite admin sources, source merging, effective equipped resolution, expired selection non-reactivation, deadline extension while still valid, and recomputation on source removal.

- [ ] **Step 2: Run resolver tests and verify RED**

Run: `npx jest src/avatar-frame/avatar-frame.service.spec.ts --runInBand`

- [ ] **Step 3: Implement the minimal resolver**

Keep all eligibility and deadline logic in `AvatarFrameService`. Return explicit `ownedSources`, `availableUntil`, and effective `equippedFrameId`.

- [ ] **Step 4: Write failing API tests**

Cover `GET /avatar-frames/me`, `PUT /avatar-frames/me/equipped`, `null` unequip, invalid/inactive/unowned IDs, auth ownership, and stable error codes.

- [ ] **Step 5: Implement controllers/DTOs/module wiring**

Use `JwtGuard`, UUID validation, bounded payloads, and user ID from the authenticated request only.

- [ ] **Step 6: Integrate membership mutations with selection continuity**

Export `AvatarFrameService`, import `AvatarFrameModule` into `MembershipModule`, and update membership grant/upgrade transactions so an effective selected frame's deadline extends only while the original selection is still valid. Add tests for active extension and expired selections remaining unequipped.

- [ ] **Step 7: Run focused backend tests**

Run: `npx jest src/avatar-frame src/membership/membership-admin.service.spec.ts --runInBand`

Expected: PASS.

### Task 3: Expose effective appearance everywhere

**Files:**
- Modify: `src/user/user.controller.ts`
- Modify: `src/user/user.service.ts`
- Modify: `src/user/user.select.ts`
- Modify: `src/user/dto/public-user.dto.ts`
- Modify: `src/auth/auth.service.ts`
- Modify: `src/friend/friend.service.ts`
- Modify: `src/friend/friend.module.ts`
- Modify: `src/friend/dto/friend.dto.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`
- Modify: `src/circle-plaza/circle-plaza.module.ts`
- Modify: `src/circle-plaza/dto/circle-plaza.dto.ts`
- Modify: `src/trace/trace.service.ts`
- Modify: `src/trace/trace.module.ts`
- Modify: `src/trace/dto/trace.dto.ts`
- Modify: `src/trace/trace.service.spec.ts`
- Modify: `src/user/user.module.ts`
- Modify: `src/auth/auth.module.ts`
- Create: `src/avatar-frame/avatar-frame-appearance.spec.ts`
- Modify focused existing service/DTO specs beside each file.

- [ ] **Step 1: Write failing serialization and batch tests**

Verify self/public user, friend rows, plaza authors, and trace/moment authors carry `avatarFrameAppearance`; `POST /user/appearances` deduplicates IDs, enforces a cap, and resolves in bounded queries.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx jest src/avatar-frame/avatar-frame-appearance.spec.ts src/user src/friend src/circle-plaza src/trace --runInBand`

- [ ] **Step 3: Add batched appearance resolution and serializers**

Preserve the legacy `avatarFrame` field, add the structured effective appearance, and avoid per-row resolver calls.

Export `AvatarFrameService` from `AvatarFrameModule` and explicitly import that module from `UserModule`, `AuthModule`, `FriendModule`, `CirclePlazaModule`, `TraceModule`, and `MembershipModule`; do not make the feature implicitly global.

- [ ] **Step 4: Wire cache invalidation and realtime refresh**

Selection, grant/revoke, and membership mutations invalidate the same user-profile hot cache and broadcast a fresh profile summary.

- [ ] **Step 5: Run focused tests**

Expected: all targeted suites PASS.

### Task 4: Add audited administrator grant and revoke APIs

**Files:**
- Create: `src/avatar-frame/avatar-frame-admin.controller.ts`
- Create: `src/avatar-frame/avatar-frame-admin.service.ts`
- Create: `src/avatar-frame/avatar-frame-admin.controller.spec.ts`
- Create: `src/avatar-frame/avatar-frame-admin.service.spec.ts`
- Modify: `src/avatar-frame/avatar-frame.module.ts`
- Modify: `src/admin-user/admin-user.service.ts`
- Modify: `src/admin-user/dto/admin-user.dto.ts`

- [ ] **Step 1: Write failing admin service tests**

Cover asset catalog listing plus permanent/finite grants, same-request idempotency replay, conflicting key reuse, revoke, revoke with another source remaining, selection deadline recomputation, missing users/assets, inactive assets, and transaction-bound strict audit.

- [ ] **Step 2: Run and verify RED**

Run: `npx jest src/avatar-frame/avatar-frame-admin.service.spec.ts --runInBand`

- [ ] **Step 3: Implement transactional grant/revoke services**

Use `JwtGuard` + `AdminGuard`, authenticated operator identity, serializable transactions where concurrent grant/revoke can race, and post-commit cache/realtime side effects.

Implement `GET /admin/avatar-frames/assets` as the authoritative active catalog source for the admin grant selector, with stable ordering and no inactive assets.

- [ ] **Step 4: Add admin user inventory responses**

Return membership-derived items read-only and all administrator grants including revoked/expired state for audit display.

- [ ] **Step 5: Run focused backend tests**

Run: `npx jest src/avatar-frame src/admin-user --runInBand`

### Task 5: Replace the mobile VIP-only frame cache with resolved appearance

**Files:**
- Create: `/Users/yiboding/projects/circle-im/src/services/api/avatar-frames.ts`
- Create: `/Users/yiboding/projects/circle-im/src/stores/userAppearanceStore.ts`
- Modify: `/Users/yiboding/projects/circle-im/src/stores/userVipStore.ts`
- Modify: `/Users/yiboding/projects/circle-im/src/services/api/users.ts`
- Modify: `/Users/yiboding/projects/circle-im/src/services/api/auth.ts`
- Modify: `/Users/yiboding/projects/circle-im/src/services/api/utils.ts`
- Modify: `/Users/yiboding/projects/circle-im/src/features/profile/membership-frames.ts`
- Create: `/Users/yiboding/projects/circle-im/test/avatar-frames-api.test.js`
- Create: `/Users/yiboding/projects/circle-im/test/user-appearance-store.test.js`

- [ ] **Step 1: Write failing API/source resolution tests**

Cover wardrobe mapping, equip `string|null`, built-in key → local asset, remote URL fallback, malformed response rejection, and appearance batch response validation.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/avatar-frames-api.test.js test/user-appearance-store.test.js`

- [ ] **Step 3: Implement mobile data layer**

Expose typed `AvatarFrameAsset`, `AvatarFrameInventoryItem`, `AvatarFrameAppearance`, and one source resolver. The appearance store batches mounted IDs and retains VIP-name behavior while adding frame appearance.

- [ ] **Step 4: Run targeted tests and typecheck**

Run: `node --test test/avatar-frames-api.test.js test/user-appearance-store.test.js && npm run typecheck`

### Task 6: Build “我的装扮”, collection, and detail pages

**Files:**
- Create: `/Users/yiboding/projects/circle-im/app/(tabs)/profile/decorations.tsx`
- Create: `/Users/yiboding/projects/circle-im/app/(tabs)/profile/avatar-frames.tsx`
- Create: `/Users/yiboding/projects/circle-im/app/(tabs)/profile/avatar-frame/[id].tsx`
- Create: `/Users/yiboding/projects/circle-im/src/features/profile/screens/MyDecorationsScreen.tsx`
- Create: `/Users/yiboding/projects/circle-im/src/features/profile/screens/AvatarFramesScreen.tsx`
- Create: `/Users/yiboding/projects/circle-im/src/features/profile/screens/AvatarFrameDetailScreen.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/features/profile/screens/ProfileScreen.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/i18n/locales/{zh,en,ja,ko,es}.json`
- Create: `/Users/yiboding/projects/circle-im/test/avatar-frame-wardrobe-pages.test.js`

- [ ] **Step 1: Write failing navigation/page contract tests**

Assert “我的装扮” copy and route, two hub entries, current preview, “无头像框”, inventory rows, detail metadata, equip/unequip actions, pending guard, retry/error states, and all locale key parity.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/avatar-frame-wardrobe-pages.test.js`

- [ ] **Step 3: Implement the three screens and route files**

Follow existing `NavHeader`, `MenuRow`, theme, safe-area, loading/error, and API error patterns. Keep the existing badge screen unchanged as the badge destination.

- [ ] **Step 4: Run mobile tests, typecheck, and targeted lint**

Run: `node --test test/avatar-frame-wardrobe-pages.test.js test/my-icons-screen.test.js && npm run typecheck`

### Task 7: Migrate every mobile frame surface to effective appearance

**Files:**
- Modify: `/Users/yiboding/projects/circle-im/src/features/profile/screens/ProfileScreen.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/features/user/screens/UserProfileScreen.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/features/chat/components/bubbles/received-bubble.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/features/chat/components/bubbles/sent-bubble.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/features/discover/components/moment-card.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/features/discover/components/plaza-post-card.tsx`
- Modify: `/Users/yiboding/projects/circle-im/src/features/discover/screens/MomentDetailScreen.tsx`
- Modify: `/Users/yiboding/projects/circle-im/test/avatar-frame-surfaces.test.js`
- Modify: `/Users/yiboding/projects/circle-im/test/membership-avatar-frames.test.js`

- [ ] **Step 1: Change existing surface tests to require server-resolved frames**

Ensure no surface calls `getMembershipFrameAsset(vipLevel)` directly; messages remain intentionally frame-free.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/avatar-frame-surfaces.test.js test/membership-avatar-frames.test.js`

- [ ] **Step 3: Update surfaces**

Self surfaces use auth user appearance, feed/profile use inline appearance, and chat bubbles use the batched appearance store. Keep compact sizing where already required.

- [ ] **Step 4: Run mobile verification**

Run: `npm test && npm run typecheck`

### Task 8: Add management UI to the admin user detail

**Files:**
- Create: `/Users/yiboding/projects/circle_admin_web/src/api/avatar-frames.ts`
- Create: `/Users/yiboding/projects/circle_admin_web/src/api/avatar-frames.test.ts`
- Create: `/Users/yiboding/projects/circle_admin_web/src/components/UserAvatarFramesCard.tsx`
- Create: `/Users/yiboding/projects/circle_admin_web/src/components/UserAvatarFramesCard.test.tsx`
- Modify: `/Users/yiboding/projects/circle_admin_web/src/pages/UserDetailPage.tsx`
- Modify: `/Users/yiboding/projects/circle_admin_web/src/pages/UserDetailPage.test.tsx`
- Modify: `/Users/yiboding/projects/circle_admin_web/src/types.ts`

- [ ] **Step 1: Write failing API and UI tests**

Cover inventory loading, permanent/finite grant payloads with fresh idempotency keys, required reason, revoke confirmation/reason, disabled pending buttons, refetch on success, and no optimistic false success.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- src/api/avatar-frames.test.ts src/components/UserAvatarFramesCard.test.tsx`

- [ ] **Step 3: Implement API and card**

Use existing API client, Ant Design form/modal primitives, TanStack Query invalidation, and `PageError`.

- [ ] **Step 4: Run admin verification**

Run: `npm test && npm run typecheck && npm run build`

### Task 9: Cross-repository regression verification

- [ ] **Step 1: Backend focused and compile verification**

Run: `npx jest src/avatar-frame src/user src/friend src/circle-plaza src/admin-user --runInBand && npm run build && npm run lint`

- [ ] **Step 2: Mobile verification**

Run: `npm test && npm run typecheck && npx expo lint --max-warnings 0`

- [ ] **Step 3: Admin verification**

Run: `npm test && npm run build`

- [ ] **Step 4: Review diffs and migration rollout**

Run `git diff --check` in all three repositories and verify only intended files changed. Confirm backend-first then mobile/admin deployment order and note that unsupported old mobile clients cannot honor unequip.
