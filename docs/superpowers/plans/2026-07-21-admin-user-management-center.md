# WindNote Admin User Management Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the basic Admin user table with dedicated, audited Admin user APIs and a secure user 360-degree frontend while leaving VIP as a non-interactive placeholder.

**Architecture:** `circle_be` gains a focused `AdminUserModule`, an append-only `AdminAuditLog`, backend masking, audited sensitive-field reveal, transactional status changes, and aggregate detail reads. `circle_admin_web` moves its user calls to `/admin/users`, adds `/users/:userId`, keeps revealed values only in component memory for 60 seconds, and centralizes dangerous actions on the detail page.

**Tech Stack:** NestJS 11, Prisma 7, PostgreSQL, Jest, React 19, React Router 7, TanStack Query 5, Ant Design 6, Vitest.

## Global Constraints

- Keep existing `JwtGuard + AdminGuard`; do not add RBAC roles in this release.
- Keep App-facing `/api/v1/user` contracts unchanged.
- Never return passwords, security-code hashes, refresh tokens, or unrequested contact originals.
- Mask contact data on the backend; audited reveal is one field at a time and requires a 3–500 character reason.
- Valid status transitions are `ACTIVE→BANNED`, `ACTIVE→DELETED`, `BANNED→ACTIVE`, and `BANNED→DELETED`; `DELETED` is terminal.
- Ban and deletion revoke refresh rows transactionally and invoke existing access-token revocation after commit.
- VIP is copy-only: `新的月度 VIP 系统设计中`; do not read or mutate legacy `vipLevel`.
- Follow TDD: write each behavior test, run it and confirm the intended failure, then write minimal production code.
- Backend branch: `feat/admin-user-management` based on local commit `114bc67`.
- Admin branch: `feat/admin-user-management` based on `main`.

---

### Task 1: Audit persistence and stable error contract

**Files:**
- Modify: `circle_be_remote/prisma/schema.prisma`
- Create: `circle_be_remote/prisma/migrations/20260722090000_add_admin_audit_log/migration.sql`
- Modify: `circle_be_remote/src/common/app-error-codes.ts`
- Modify: `circle_be_remote/src/common/app-error-codes.spec.ts`
- Create: `circle_be_remote/src/prisma/admin-audit-migration.spec.ts`

**Interfaces:**
- Produces: Prisma delegate `adminAuditLog` and `AdminUserErrorCode` constants consumed by later backend tasks.

- [ ] **Step 1: Create both feature branches**

Run in `circle_be_remote`:

```bash
git switch -c feat/admin-user-management
```

Run in `circle_admin_web_remote`:

```bash
git switch -c feat/admin-user-management
```

Expected: both commands report a new branch.

- [ ] **Step 2: Write failing catalog and migration tests**

Add `AdminUserErrorCode` to the imports, `groups`, `AppErrorCode`, and `APP_ERROR_CODE_GROUPS` expectations in `app-error-codes.spec.ts`. Create `admin-audit-migration.spec.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AdminAuditLog migration', () => {
  const root = join(__dirname, '../..');
  const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
  const sql = readFileSync(
    join(root, 'prisma/migrations/20260722090000_add_admin_audit_log/migration.sql'),
    'utf8',
  );

  it('defines the append-only audit model and lookup indexes', () => {
    expect(schema).toContain('model AdminAuditLog');
    expect(sql).toContain('CREATE TABLE "AdminAuditLog"');
    expect(sql).toContain('AdminAuditLog_targetType_targetId_createdAt_idx');
    expect(sql).toContain('AdminAuditLog_actorId_createdAt_idx');
    expect(sql).toContain('AdminAuditLog_action_createdAt_idx');
  });
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
npm test -- app-error-codes.spec.ts admin-audit-migration.spec.ts --runInBand
```

Expected: FAIL because `AdminUserErrorCode` and the migration do not exist.

- [ ] **Step 4: Add the error group, Prisma model, and SQL migration**

Add these stable codes:

```ts
export const AdminUserErrorCode = {
  NotFound: 'ADMIN_USER_NOT_FOUND',
  SelfStatusChange: 'ADMIN_USER_SELF_STATUS_CHANGE',
  InvalidStatusTransition: 'ADMIN_USER_INVALID_STATUS_TRANSITION',
  StatusConflict: 'ADMIN_USER_STATUS_CONFLICT',
  ConfirmationMismatch: 'ADMIN_USER_CONFIRMATION_MISMATCH',
  SensitiveFieldInvalid: 'ADMIN_USER_SENSITIVE_FIELD_INVALID',
  SensitiveReasonRequired: 'ADMIN_USER_SENSITIVE_REASON_REQUIRED',
  AuditUnavailable: 'ADMIN_AUDIT_UNAVAILABLE',
} as const;
```

Add the exact `AdminAuditLog` model from the approved design and create SQL for the 12 columns plus the three indexes. Use `TEXT` for strings, `JSONB` for `before`, `after`, and `metadata`, and `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` for `createdAt`.

- [ ] **Step 5: Run the tests and verify GREEN**

Run the command from Step 3. Expected: PASS.

- [ ] **Step 6: Generate Prisma client and commit**

Run:

```bash
npm run prisma:generate
git add prisma src/common src/prisma/admin-audit-migration.spec.ts
git commit -m "feat(admin): add user audit persistence"
```

Expected: Prisma generation and commit succeed.

---

### Task 2: DTOs, masking, and audit service

**Files:**
- Create: `circle_be_remote/src/admin-user/admin-user.constants.ts`
- Create: `circle_be_remote/src/admin-user/admin-user.masking.ts`
- Create: `circle_be_remote/src/admin-user/admin-user.masking.spec.ts`
- Create: `circle_be_remote/src/admin-user/dto/admin-user.dto.ts`
- Create: `circle_be_remote/src/admin-user/dto/admin-user.dto.spec.ts`
- Create: `circle_be_remote/src/admin-user/admin-audit.service.ts`
- Create: `circle_be_remote/src/admin-user/admin-audit.service.spec.ts`

**Interfaces:**
- Produces: `SensitiveField`, `AdminAuditAction`, `maskSensitiveField`, validated request DTOs, and `AdminAuditService.recordInTransaction()` / `listForTarget()`.

- [ ] **Step 1: Write failing masking tests**

```ts
describe('maskSensitiveField', () => {
  it.each([
    ['email', null, null],
    ['email', 'jim@example.com', 'j***@example.com'],
    ['phoneNumber', '15512345678', '*******5678'],
    ['wechat', 'jimmy', 'j***y'],
    ['qq', '7', '**'],
  ] as const)('masks %s', (field, value, expected) => {
    expect(maskSensitiveField(field, value)).toBe(expected);
  });
});
```

Run `npm test -- admin-user.masking.spec.ts --runInBand`. Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement constants and masking**

```ts
export const SENSITIVE_FIELDS = [
  'email', 'phoneNumber', 'wechat', 'qq', 'whatsup',
] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

export const AdminAuditAction = {
  SensitiveFieldViewed: 'USER_SENSITIVE_FIELD_VIEWED',
  UserBanned: 'USER_BANNED',
  UserUnbanned: 'USER_UNBANNED',
  UserDeleted: 'USER_DELETED',
} as const;
```

Implement `maskSensitiveField(field, value)` exactly as the approved masking table. Re-run the masking test and expect PASS.

- [ ] **Step 3: Write failing DTO validation tests**

Use `validate()` from `class-validator` and `plainToInstance()` from `class-transformer` to prove:

- list `page=0`, `limit=101`, unknown role/status, invalid date, and keyword over 100 fail;
- reveal unknown field and reason shorter than 3 fail;
- status reason shorter than 3 fails;
- valid list, reveal, and status payloads pass.

Run `npm test -- admin-user.dto.spec.ts --runInBand`. Expected: FAIL because DTOs do not exist.

- [ ] **Step 4: Implement DTOs**

Create:

```ts
export class ListAdminUsersQueryDto {
  @IsOptional() @IsString() @MaxLength(100) keyword?: string;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @IsOptional() @IsDateString() createdFrom?: string;
  @IsOptional() @IsDateString() createdTo?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class RevealSensitiveFieldDto {
  @IsIn(SENSITIVE_FIELDS) field: SensitiveField;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class AdminUpdateUserStatusDto {
  @IsEnum(UserStatus) status: UserStatus;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsOptional() @IsString() @MaxLength(100) confirmationAccountId?: string;
}
```

Add Swagger decorators without changing validation. Re-run DTO tests and expect PASS.

- [ ] **Step 5: Write failing audit service tests**

Test that `recordInTransaction(tx, input)` calls `tx.adminAuditLog.create` with request context, never includes a supplied contact original, and that `listForTarget('user', id, limit)` orders by `createdAt: 'desc'` and caps limit at 100.

- [ ] **Step 6: Implement the audit service**

Expose:

```ts
type AuditInput = {
  actorId: string;
  actorAccountId: string;
  action: string;
  targetType: 'user';
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  metadata?: Record<string, unknown>;
};
```

`recordInTransaction` reads `getRequestContext()` for request ID, IP, and user-agent; truncates IP to 64 and user-agent to 256; and inserts only the explicit input. `listForTarget` selects the public audit columns, not arbitrary Prisma rows.

- [ ] **Step 7: Run focused tests and commit**

```bash
npm test -- admin-user.masking.spec.ts admin-user.dto.spec.ts admin-audit.service.spec.ts --runInBand
git add src/admin-user
git commit -m "feat(admin): add user DTOs masking and audit service"
```

Expected: all focused tests pass and commit succeeds.

---

### Task 3: Admin user reads and sensitive reveal

**Files:**
- Create: `circle_be_remote/src/admin-user/admin-user.service.ts`
- Create: `circle_be_remote/src/admin-user/admin-user.service.spec.ts`

**Interfaces:**
- Consumes: Task 2 DTOs, masking, and audit service.
- Produces: `listUsers`, `getUserDetail`, `revealSensitiveField`, and `listAuditLogs` for the controller.

- [ ] **Step 1: Write failing list tests**

Cover trimmed keyword OR-search across `accountId`, `nickname`, `email`, and `phoneNumber`; status, role, date filters; pagination; masked email/phone; and absence of original contacts and secrets.

The expected query shape includes:

```ts
where: {
  status: 'ACTIVE',
  OR: [
    { accountId: { contains: 'jim', mode: 'insensitive' } },
    { nickname: { contains: 'jim', mode: 'insensitive' } },
    { email: { contains: 'jim', mode: 'insensitive' } },
    { phoneNumber: { contains: 'jim' } },
  ],
}
```

Run `npm test -- admin-user.service.spec.ts --runInBand`. Expected: FAIL because the service does not exist.

- [ ] **Step 2: Implement `listUsers`**

Use one bounded `findMany` and one `count` in `Promise.all`. Select only list fields. Map `email` and `phoneNumber` to `maskedEmail` and `maskedPhoneNumber`, then omit originals.

- [ ] **Step 3: Write failing detail aggregation tests**

Mock and assert account detail plus:

- active refresh sessions;
- active push devices;
- accepted friends where the user is either side;
- notes, traces, circles owned, active circle memberships;
- reports filed and received;
- wallet balance zero when no wallet exists.

Assert the result has `maskedContacts`, `security`, and `summary`, contains no original contacts, and does not contain `vipLevel`.

- [ ] **Step 4: Implement `getUserDetail`**

Perform the profile lookup first and throw `NotFoundException` with `AdminUserErrorCode.NotFound` when absent. Run independent bounded aggregate reads with `Promise.all`. Return:

```ts
{
  profile: { id, accountId, nickname, avatarUrl, role, status, city, region,
    gender, createdAt, updatedAt, lastOnline },
  maskedContacts: { email, phoneNumber, wechat, qq, whatsup },
  security: { securityCodeLocked, singleDeviceLoginEnabled,
    activeSessionCount, activePushDeviceCount, openimSynced },
  summary: { creditScore, walletBalance, friendCount, noteCount, traceCount,
    circlesOwnedCount, circleMembershipCount, reportsFiledCount,
    reportsReceivedCount },
}
```

- [ ] **Step 5: Write failing reveal tests**

Prove one selected field is read, `AdminAuditAction.SensitiveFieldViewed` is recorded with metadata `{ field }`, no value is passed to the audit service, and audit failure becomes `ServiceUnavailableException` with `AdminUserErrorCode.AuditUnavailable` before any response is returned.

- [ ] **Step 6: Implement reveal and audit listing**

`revealSensitiveField(actor, targetId, dto)` selects `id` plus the requested field, records the audit event, and returns `field`, `value`, `revealedAt`, and `expiresAt = revealedAt + 60_000`. `listAuditLogs` delegates to `AdminAuditService.listForTarget('user', targetId, limit)` after confirming the target exists.

- [ ] **Step 7: Run focused tests and commit**

```bash
npm test -- admin-user.service.spec.ts --runInBand
git add src/admin-user/admin-user.service.ts src/admin-user/admin-user.service.spec.ts
git commit -m "feat(admin): add secure user reads and sensitive reveal"
```

Expected: focused service tests pass.

---

### Task 4: Transactional status actions and HTTP wiring

**Files:**
- Modify: `circle_be_remote/src/admin-user/admin-user.service.ts`
- Modify: `circle_be_remote/src/admin-user/admin-user.service.spec.ts`
- Create: `circle_be_remote/src/admin-user/admin-user.controller.ts`
- Create: `circle_be_remote/src/admin-user/admin-user.controller.spec.ts`
- Create: `circle_be_remote/src/admin-user/admin-user.module.ts`
- Modify: `circle_be_remote/src/app.module.ts`
- Modify: `circle_be_remote/src/metrics/route-normalizer.ts`
- Modify: `circle_be_remote/src/metrics/route-normalizer.spec.ts`

**Interfaces:**
- Produces the approved `/admin/users` HTTP surface for the Admin frontend.

- [ ] **Step 1: Write failing status tests**

Test all four valid transitions, all other transition pairs, self-ban/delete,
delete confirmation mismatch, conditional-update conflict, refresh-row
revocation for ban/delete, no refresh-row revocation for unban, transactional
audit, transaction rollback on audit failure, and post-commit access-token
revocation/cache broadcast.

Run `npm test -- admin-user.service.spec.ts --runInBand`. Expected: FAIL because status mutation is absent.

- [ ] **Step 2: Implement `updateStatus`**

Inside `prisma.$transaction`:

```ts
const current = await tx.user.findUnique({
  where: { id: targetId },
  select: { id: true, accountId: true, status: true },
});
// validate existence, self-action, allowed transition, reason, confirmation
const changed = await tx.user.updateMany({
  where: { id: targetId, status: current.status },
  data: { status: dto.status },
});
if (changed.count !== 1) throw statusConflict();
if (dto.status !== UserStatus.ACTIVE) {
  await tx.refreshToken.updateMany({
    where: { userId: targetId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
await audit.recordInTransaction(tx, {
  actorId: actor.userId,
  actorAccountId: actor.accountId,
  action,
  targetType: 'user',
  targetId,
  before: { status: current.status },
  after: { status: dto.status },
  reason: dto.reason.trim(),
});
```

After commit, call `SessionRevocationService.revokeUser` for ban/delete and call
`RealtimeService.invalidateUserProfileSummaryCache` plus
`broadcastUserProfileSummary`. Catch and log post-commit external failures so a
committed status operation is not reported as rolled back.

- [ ] **Step 3: Write failing controller and route-normalizer tests**

Assert controller-level guards are `[JwtGuard, AdminGuard]`, UUID parsing is
present, each method delegates actor `{ userId, accountId }`, and concrete
paths containing a UUID normalize to `/api/v1/admin/users/:id`,
`/sensitive-access`, `/status`, and `/audit-logs` templates.

- [ ] **Step 4: Implement controller, module, and app wiring**

Controller routes:

```ts
@Get() list(@Query() query: ListAdminUsersQueryDto)
@Get(':id') detail(@Param('id', ParseUUIDPipe) id: string)
@Post(':id/sensitive-access') reveal(...)
@Patch(':id/status') updateStatus(...)
@Get(':id/audit-logs') auditLogs(...)
```

Register `AdminUserModule` in `AppModule`. Import `RealtimeModule` and `AuthModule`
in the feature module; provide the controller, `AdminUserService`, and
`AdminAuditService`.

- [ ] **Step 5: Run backend focused verification and commit**

```bash
npm test -- admin-user app-error-codes.spec.ts route-normalizer.spec.ts admin-audit-migration.spec.ts --runInBand
npm run build
git add src/admin-user src/app.module.ts src/metrics
git commit -m "feat(admin): expose audited user management API"
```

Expected: focused tests and build pass.

---

### Task 5: Admin frontend contracts and API client

**Files:**
- Modify: `circle_admin_web_remote/src/types.ts`
- Modify: `circle_admin_web_remote/src/api/users.ts`
- Modify: `circle_admin_web_remote/src/api/users.test.ts`

**Interfaces:**
- Consumes the Task 4 HTTP API.
- Produces `listUsers`, `getUserDetail`, `revealSensitiveField`, `updateUserStatus`, and `listUserAuditLogs`.

- [ ] **Step 1: Write failing API tests**

Mock `apiClient` and assert exact paths and bodies:

```ts
expect(apiClient).toHaveBeenCalledWith('/admin/users?keyword=jim&page=1&limit=20');
expect(apiClient).toHaveBeenCalledWith('/admin/users/u1');
expect(apiClient).toHaveBeenCalledWith('/admin/users/u1/sensitive-access', {
  method: 'POST', body: JSON.stringify({ field: 'phoneNumber', reason: 'CS-1024' }),
});
expect(apiClient).toHaveBeenCalledWith('/admin/users/u1/status', {
  method: 'PATCH', body: JSON.stringify({ status: 'BANNED', reason: 'abuse' }),
});
```

Run `npm test -- src/api/users.test.ts`. Expected: FAIL against legacy `/user` calls.

- [ ] **Step 2: Add exact frontend types**

Add `AdminUserListItem`, `AdminUserDetail`, `MaskedContacts`, `UserSecuritySummary`,
`UserBusinessSummary`, `SensitiveField`, `SensitiveAccessResponse`,
`AdminAuditLog`, and `AdminUpdateUserStatusPayload` matching the backend contract.
Keep the existing, permissive `AdminUser` summary type unchanged for report
components; the stricter list/detail types are used only by the user center.

- [ ] **Step 3: Implement API functions and query builder**

`userListQueryString` accepts `keyword`, `status`, `role`, `createdFrom`,
`createdTo`, `page`, and `limit`, trims keyword, and omits empty filters. Change
list calls to `/admin/users`. Add detail, reveal, status, and audit calls.

- [ ] **Step 4: Run tests and commit**

```bash
npm test -- src/api/users.test.ts
git add src/types.ts src/api/users.ts src/api/users.test.ts
git commit -m "feat(admin): add user management API client"
```

Expected: API tests pass.

---

### Task 6: Searchable user list and detail navigation

**Files:**
- Modify: `circle_admin_web_remote/src/pages/UsersPage.tsx`
- Modify: `circle_admin_web_remote/src/pages/UsersPage.test.tsx`

**Interfaces:**
- Consumes `listUsers` and navigates to `/users/:userId`.
- Produces the list route used by the detail page backlink.

- [ ] **Step 1: Write failing helper and rendering tests**

Test query construction for keyword/status/role/date filters, pagination reset
when a filter changes, masked columns, absence of ban/delete row buttons, and a
single `查看详情` action that navigates to `/users/u1`.

Run `npm test -- src/pages/UsersPage.test.tsx`. Expected: FAIL against the legacy table.

- [ ] **Step 2: Implement the new list page**

Use `Input.Search`, status and role `Select`s, two date inputs or Ant Design
`RangePicker`, and server-side pagination. Columns are avatar, account ID,
nickname, masked email, masked phone, status, role, created time, last online,
and `查看详情`. Keep query key `['admin-users', query]`.

- [ ] **Step 3: Run tests and commit**

```bash
npm test -- src/pages/UsersPage.test.tsx
git add src/pages/UsersPage.tsx src/pages/UsersPage.test.tsx
git commit -m "feat(admin): upgrade searchable user list"
```

Expected: list tests pass.

---

### Task 7: User 360-degree detail, reveal, actions, and VIP placeholder

**Files:**
- Create: `circle_admin_web_remote/src/pages/UserDetailPage.tsx`
- Create: `circle_admin_web_remote/src/pages/UserDetailPage.test.tsx`
- Create: `circle_admin_web_remote/src/components/SensitiveFieldValue.tsx`
- Create: `circle_admin_web_remote/src/components/SensitiveFieldValue.test.tsx`
- Create: `circle_admin_web_remote/src/components/UserStatusActions.tsx`
- Create: `circle_admin_web_remote/src/components/UserStatusActions.test.tsx`
- Modify: `circle_admin_web_remote/src/app/App.tsx`
- Modify: `circle_admin_web_remote/src/styles.css`

**Interfaces:**
- Consumes Task 5 APIs and `currentUser` from authenticated routes.
- Produces `/users/:userId` with all approved sections.

- [ ] **Step 1: Write failing sensitive-field tests**

Use fake timers to prove masked default, required reason, API reveal, original
value visible only in memory, automatic remasking at 60 seconds, and cleanup on
unmount. Run `npm test -- src/components/SensitiveFieldValue.test.tsx` and expect FAIL.

- [ ] **Step 2: Implement `SensitiveFieldValue`**

The component receives `userId`, `field`, `maskedValue`, and `label`. It opens a
small modal with a required 3–500 character reason, calls
`revealSensitiveField`, stores the returned value in `useState`, schedules one
timeout from `expiresAt`, and clears that timeout plus value during cleanup.

- [ ] **Step 3: Write failing status-action tests**

Test the allowed transition matrix, self-action disabled state, reason required
for every transition, exact account ID required for deletion, DELETED read-only,
and payloads sent to `updateUserStatus`.

- [ ] **Step 4: Implement `UserStatusActions`**

Render only actions allowed by current status. Use a modal form. Invalidate
`['admin-users']`, `['admin-user', userId]`, and `['admin-user-audit', userId]`
after success. Keep backend validation authoritative.

- [ ] **Step 5: Write failing detail-page tests**

Mock detail and audit APIs. Assert account, contacts, security, business summary,
last 20 audits, the exact VIP placeholder copy, no VIP mutation button, loading,
404/error state, and backlink.

- [ ] **Step 6: Implement `UserDetailPage` and route**

Use separate Ant Design cards for account, contacts, security, summary, VIP,
dangerous actions, and audit history. Fetch:

```ts
useQuery({ queryKey: ['admin-user', userId], queryFn: () => getUserDetail(userId) })
useQuery({ queryKey: ['admin-user-audit', userId], queryFn: () => listUserAuditLogs(userId, 20) })
```

Pass the authenticated Admin to `UserStatusActions`; add the route in `App.tsx`.
Add responsive card/grid styles without changing unrelated pages.

- [ ] **Step 7: Run frontend verification and commit**

```bash
npm test -- src/pages/UsersPage.test.tsx src/pages/UserDetailPage.test.tsx src/components/SensitiveFieldValue.test.tsx src/components/UserStatusActions.test.tsx src/api/users.test.ts
npm run typecheck
npm run build
git add src
git commit -m "feat(admin): add user management center"
```

Expected: targeted tests, typecheck, and build pass.

---

### Task 8: Documentation, cross-repository verification, and handoff

**Files:**
- Modify: `circle_be_remote/docs/api-integration.md`
- Modify: `circle_admin_web_remote/README.md`
- Modify: `circle_be_remote/docs/superpowers/plans/2026-07-21-admin-user-management-center.md` only to check completed boxes during execution.

**Interfaces:**
- Documents the final HTTP contract and operational rollout.

- [ ] **Step 1: Update API and Admin documentation**

Document all five `/admin/users` endpoints, filters, status transitions, audit
redaction, deployment order, and the VIP placeholder non-goal. Update the Admin
README feature list and verification commands.

- [ ] **Step 2: Run full backend verification**

```bash
npm test -- --runInBand
npm run build
```

Expected: zero Jest failures and build exit code 0. If full tests are blocked by
missing external services, record the exact blocked suites and keep all unit
and HTTP controller suites green.

- [ ] **Step 3: Run full Admin verification**

```bash
npm test
npm run typecheck
npm run build
```

Expected: zero Vitest failures, typecheck exit code 0, and Vite build exit code 0.

- [ ] **Step 4: Inspect both diffs and privacy boundaries**

Run `git diff --check` and `git status --short` in both repositories. Search the
Admin frontend for `vipLevel`, `passwordHash`, `loginSecurityCodeHash`, and
`refreshToken`; the new user-management files must not consume them. Search
backend audit creation for contact field values; only field names may enter
audit metadata.

- [ ] **Step 5: Commit documentation**

Backend:

```bash
git add docs/api-integration.md docs/superpowers/plans/2026-07-21-admin-user-management-center.md
git commit -m "docs: document admin user management API"
```

Admin:

```bash
git add README.md
git commit -m "docs: document user management center"
```

- [ ] **Step 6: Final requirement review**

Re-read the approved design and verify every success criterion against a test,
build result, or inspected response contract. Report exact commit SHAs and any
remaining rollout-only steps. Do not push or deploy unless the user separately
authorizes publication.
