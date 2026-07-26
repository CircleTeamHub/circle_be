# Remaining Backend Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four confirmed backend findings while leaving public photo/media access unchanged.

**Architecture:** Keep both list response bodies as bare arrays and add bounded, owner-scoped keyset pagination using `(createdAt DESC, id DESC)`. Scope IM-token throttling to the authenticated JWT subject, and rotate the Prometheus credential through a privileged staged file plus atomic rename.

**Tech Stack:** NestJS 11, TypeScript, Prisma 7, Jest/Supertest, Bash, GitHub Actions.

## Global Constraints

- Do not change the MinIO public-prefix policy or media URL contracts.
- Preserve the existing bare-array response bodies for circle and share-link list endpoints.
- Use `limit=50` by default and reject values above `100`.
- Use deterministic `(createdAt DESC, id DESC)` ordering.
- Reject cursors outside the authenticated user's current endpoint/filter scope.
- Keep the IM-token rate at 10 requests per 60 seconds.
- Do not add product-level count limits or a database migration.
- Follow red-green TDD for every production behavior.

---

### Task 1: Bound `GET /circle/my` with stable cursor pagination

**Files:**
- Modify: `src/common/app-error-codes.ts`
- Modify: `src/circle/dto/circle.dto.ts`
- Modify: `src/circle/circle.service.ts`
- Test: `src/circle/circle.service.spec.ts`

**Interfaces:**
- Consumes: `MyCirclesQueryDto { tab; cursor?; limit? }` and authenticated `userId`.
- Produces: unchanged `Promise<MyCircleDto[]>`; cursor is the last returned circle ID; invalid anchors throw `CIRCLE_INVALID_CURSOR`.

- [ ] **Step 1: Write failing DTO and service tests**

Add validation assertions for optional UUID `cursor`, integer `limit`, default behavior, maximum 100, and these service expectations:

```ts
expect(prisma.circle.findMany).toHaveBeenCalledWith({
  where: { ownerID: 'user-1', deleted: false },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: 50,
});

expect(prisma.circleMember.findMany).toHaveBeenCalledWith(
  expect.objectContaining({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
  }),
);
```

For cursors, mock an in-scope anchor and assert the strict tuple predicate; mock `null` and assert `BadRequestException.response.errorCode === 'CIRCLE_INVALID_CURSOR'` before the page query.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- --runInBand src/circle/circle.service.spec.ts`

Expected: failures show missing `limit`/`cursor`, missing `take`, non-deterministic ordering, and no invalid-cursor error.

- [ ] **Step 3: Implement the minimum cursor contract**

Add `CircleErrorCode.InvalidCursor`, DTO decorators, and service logic. For created circles resolve the anchor with:

```ts
{ id: query.cursor, ownerID: userId, deleted: false }
```

For joined/applied resolve a `CircleMember` by `circleID`, `userID`, matching status/role, and non-deleted circle. Apply this strict seek predicate to the matching model:

```ts
OR: [
  { createdAt: { lt: anchor.createdAt } },
  { createdAt: anchor.createdAt, id: { lt: anchor.id } },
]
```

Use `take: query.limit ?? 50` and tuple ordering for every tab.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- --runInBand src/circle/circle.service.spec.ts`

Expected: suite passes with pagination and foreign/stale cursor coverage.

- [ ] **Step 5: Commit the circle fix**

```bash
git add src/common/app-error-codes.ts src/circle/dto/circle.dto.ts src/circle/circle.service.ts src/circle/circle.service.spec.ts
git commit -m "fix(circle): bound my circles pagination"
```

### Task 2: Key IM-token throttling by authenticated user

**Files:**
- Create: `src/auth/im-token-throttler.guard.ts`
- Create: `src/auth/im-token-throttler.guard.spec.ts`
- Modify: `src/auth/auth.controller.ts`
- Modify: `src/auth/auth.module.ts`
- Modify: `src/auth/auth-im-token.controller.spec.ts`
- Modify: `src/auth/__test__/auth.controller.spec.ts`

**Interfaces:**
- Consumes: `req.user.userId` populated by `JwtGuard`.
- Produces: tracker `user:<userId>`; delegates to the stock IP tracker only when the request has no authenticated user.

- [ ] **Step 1: Write failing guard and HTTP tests**

The unit test exposes `getTracker` through a test subclass and asserts:

```ts
await expect(guard.tracker({ user: { userId: 'user-1' }, ip: '10.0.0.1' }))
  .resolves.toBe('user:user-1');
```

The HTTP regression sends ten requests for user A and ten for user B from the same socket/IP, then asserts A's eleventh request is 429 and `getImToken` was called exactly 20 times.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- --runInBand src/auth/im-token-throttler.guard.spec.ts src/auth/auth-im-token.controller.spec.ts`

Expected: the guard module is missing and the second user shares the first user's exhausted IP budget.

- [ ] **Step 3: Add the route-specific guard**

Implement:

```ts
@Injectable()
export class ImTokenThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req.user?.userId;
    return typeof userId === 'string' && userId.length > 0
      ? `user:${userId}`
      : super.getTracker(req);
  }
}
```

Register it in `AuthModule`, use `@UseGuards(JwtGuard, ImTokenThrottlerGuard)`, and add the provider to focused testing modules.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- --runInBand src/auth/im-token-throttler.guard.spec.ts src/auth/auth-im-token.controller.spec.ts src/auth/__test__/auth.controller.spec.ts`

Expected: independent user budgets, 429 overflow, JWT/auth tests all pass.

- [ ] **Step 5: Commit the auth fix**

```bash
git add src/auth
git commit -m "fix(auth): throttle IM tokens per user"
```

### Task 3: Make metrics-token rotation repeatable and atomic

**Files:**
- Modify: `monitoring/sync-metrics-token.sh`
- Create: `test/sync-metrics-token.spec.sh`
- Modify: `monitoring/README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `ENV_FILE`, optional `TOKEN_FILE`, validated `METRICS_AUTH_TOKEN`, root or passwordless sudo.
- Produces: a `0600` uid/gid 65534 credential atomically replaced at `TOKEN_FILE`.

- [ ] **Step 1: Write the failing Linux shell regression**

The test creates a temporary env and target, runs the script once, changes the env token, runs it again while the first target is owned by 65534 and non-writable, then asserts:

```bash
test "$(sudo cat "$token_file")" = 'second-token'
test "$(stat -c '%a' "$token_file")" = '600'
test "$(stat -c '%u:%g' "$token_file")" = '65534:65534'
```

It also runs with privilege deliberately unavailable and proves the original target content is unchanged.

- [ ] **Step 2: Run on Linux and confirm RED**

Run: `bash test/sync-metrics-token.spec.sh`

Expected: the second invocation fails at direct shell redirection into the Prometheus-owned file.

- [ ] **Step 3: Implement staged privileged replacement**

Use `mktemp` beside the destination for the caller-owned source, validate privilege before replacement, then run either direct root or `sudo -n` commands equivalent to:

```bash
install -m 600 -o 65534 -g 65534 "$temp_file" "$staged_file"
mv -f "$staged_file" "$TOKEN_FILE"
```

Trap cleanup for caller/staged temporary files. Change operator output and `monitoring/README.md` to:

```bash
docker compose -f monitoring/docker-compose.yml \
  -f monitoring/docker-compose.prod.yml up -d --force-recreate prometheus
```

Add `bash test/sync-metrics-token.spec.sh` to CI's release-contract step.

- [ ] **Step 4: Run shell checks and confirm GREEN**

Run: `bash -n monitoring/sync-metrics-token.sh && bash -n test/sync-metrics-token.spec.sh && bash test/sync-metrics-token.spec.sh`

Expected: both syntax checks and repeated rotation test pass.

- [ ] **Step 5: Commit the rotation fix**

```bash
git add monitoring/sync-metrics-token.sh monitoring/README.md test/sync-metrics-token.spec.sh .github/workflows/ci.yml
git commit -m "fix(monitoring): rotate metrics token atomically"
```

### Task 4: Replace share-link offset pagination with stable cursors

**Files:**
- Modify: `src/common/app-error-codes.ts`
- Modify: `src/note/dto/note.dto.ts`
- Modify: `src/note/dto/note.dto.spec.ts`
- Modify: `src/note/note.service.ts`
- Modify: `src/note/note.service.spec.ts`
- Modify: `src/note/note.controller.spec.ts`
- Modify: `src/note/note-share-link-routing.spec.ts`

**Interfaces:**
- Consumes: `ListNoteShareLinksQueryDto { cursor?; limit? }` and authenticated owner ID.
- Produces: unchanged `Promise<NoteShareLinkDto[]>`; cursor is last link ID; invalid anchors throw `NOTE_SHARE_LINK_INVALID_CURSOR`.

- [ ] **Step 1: Replace offset tests with failing cursor tests**

Assert `page` is rejected/removed, `cursor` accepts a UUID, limit max is 100, the anchor lookup includes `ownerID`, and the page query uses:

```ts
orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
take: 50,
where: {
  ownerID: 'user-1',
  OR: [
    { createdAt: { lt: anchor.createdAt } },
    { createdAt: anchor.createdAt, id: { lt: anchor.id } },
  ],
},
```

Foreign/missing cursors must reject with `NOTE_SHARE_LINK_INVALID_CURSOR`, and routing/controller tests pass `cursor` rather than `page`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- --runInBand src/note/dto/note.dto.spec.ts src/note/note.service.spec.ts src/note/note.controller.spec.ts src/note/note-share-link-routing.spec.ts`

Expected: old page/skip assertions fail and cursor behavior is absent.

- [ ] **Step 3: Implement owner-scoped tuple pagination**

Add `NoteErrorCode.ShareLinkInvalidCursor`, replace `page` with optional UUID `cursor`, cap `limit` at 100, resolve the anchor using `{ id: cursor, ownerID }`, throw HTTP 400 on a missing anchor, and query strictly after it with deterministic tuple order and no `skip`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Task 4 test command again.

Expected: DTO, service, controller, and HTTP routing suites pass.

- [ ] **Step 5: Commit the note fix**

```bash
git add src/common/app-error-codes.ts src/note
git commit -m "fix(note): stabilize share-link pagination"
```

### Task 5: Final verification

**Files:**
- Verify all files changed by Tasks 1-4.

**Interfaces:**
- Consumes: the four independently green changes.
- Produces: review-ready local branch; no push or remote mutation.

- [ ] **Step 1: Run targeted regression suites together**

Run: `npm test -- --runInBand src/circle/circle.service.spec.ts src/auth/im-token-throttler.guard.spec.ts src/auth/auth-im-token.controller.spec.ts src/note/dto/note.dto.spec.ts src/note/note.service.spec.ts src/note/note.controller.spec.ts src/note/note-share-link-routing.spec.ts`

- [ ] **Step 2: Run full unit, type/build, lint, and shell verification**

```bash
npm test -- --runInBand
npx tsc --noEmit
npm run build
npx eslint "{src,apps,libs,test}/**/*.ts"
bash -n monitoring/sync-metrics-token.sh
bash -n test/sync-metrics-token.spec.sh
bash test/sync-metrics-token.spec.sh
git diff --check origin/main...HEAD
```

Expected: every command exits 0; Jest reports zero failed suites/tests; ESLint reports zero errors; the shell regression verifies the second token and ownership.

- [ ] **Step 3: Review scope and branch state**

Run: `git status --short && git diff --stat origin/main...HEAD`

Expected: only the plan/design and four requested fixes are present; no MinIO public-prefix or media URL change appears.
