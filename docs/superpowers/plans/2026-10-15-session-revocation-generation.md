# Session Revocation Generation Implementation Plan

**Goal:** Replace history-wide access-token revocation writes with constant-size scope generation updates while preserving refresh-session behavior and immediate WebSocket disconnects.

**Architecture:** Each `RefreshToken` row stores generation snapshots for account, audience, device, and family scopes. `SessionScopeGeneration` stores the current generation for one indexed scope. Scoped revocation increments exactly one generation row and keeps the existing update of currently-active refresh rows; `SessionVerifier` compares snapshots to current generations for durable access-token enforcement. Scope broadcasts carry enough information for both realtime gateways to disconnect matching sockets without enumerating historical token rows.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Jest, Redis pub/sub.

---

### Task 1: Lock the desired generation semantics with failing tests

**Files:**

- Modify: `src/auth/__test__/session-verifier.service.spec.ts`
- Modify: `src/auth/__test__/refresh-token.service.spec.ts`
- Modify: `src/auth/session-revocation.service.spec.ts`
- Modify: `src/realtime/realtime.service.spec.ts`

1. Add verifier tests for mismatched device/family/account generations and account-family exemption.
2. Add refresh-service tests proving a scoped revoke increments one generation row and does not write `accessRevokedAt` across rotation history.
3. Add parser and realtime matching tests for scope broadcasts.
4. Run the focused tests and confirm they fail for missing generation behavior.

### Task 2: Add the generation data model and migration

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261015020000_add_session_revocation_generations/migration.sql`

1. Add `SessionRevocationScope` and `SessionScopeGeneration` with a unique `(userId, scope, scopeKey)` key.
2. Add four non-null generation snapshot columns to `RefreshToken`, defaulting to zero for existing rows.
3. Add the migration with indexed lookups and cascade cleanup.
4. Run Prisma validation/generation and inspect the SQL.

### Task 3: Write and consume scope generations

**Files:**

- Modify: `src/auth/refresh-token.service.ts`
- Modify: `src/auth/session-verifier.service.ts`

1. Snapshot current generations when a refresh row is created.
2. Increment the family/device/account/audience scope in scoped revocation operations.
3. Remove history-wide `accessRevokedAt` updates and their per-history-row notification path from those operations.
4. Compare persisted session snapshots against current scope generations in `SessionVerifier`, honoring the preserved family for account/audience replacement.
5. Keep direct single-session and global-user revocation behavior unchanged.

### Task 4: Preserve immediate realtime revocation

**Files:**

- Modify: `src/auth/session-revocation.broadcast.ts`
- Modify: `src/auth/session-revocation.service.ts`
- Modify: `src/realtime/realtime.service.ts`
- Modify: `src/realtime/realtime.gateway.ts`
- Modify: `src/chat/chat.gateway.ts`

1. Add a validated scope broadcast shape.
2. Return active session scope identity from the shared verifier.
3. Store that identity on both realtime socket implementations.
4. Disconnect only sockets matched by the revoked scope.

### Task 5: Verify and commit

**Files:**

- Review all changed files.

1. Run focused auth/realtime tests.
2. Run `npm run build`, `npm run lint`, and the relevant broader auth test set.
3. Inspect `git diff --check`, schema migration, and the final diff for security/compatibility regressions.
4. Create one local commit on `codex/fix-revocation-generation-20261015`; do not push or open a PR.
