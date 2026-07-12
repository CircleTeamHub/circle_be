# Plaza Signup Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent new plaza-post signups by users who are not active members of any non-deleted linked circle while preserving the endpoint's existing idempotent response for an already-created signup.

**Architecture:** Extend the existing post lookup to select one linked circle matching `memberCircleScope(userId)`. Keep the existing-signup fast path before the new authorization rejection, then reject only a new signup when the selected relation is empty. Verify both service control flow and real PostgreSQL relation semantics.

**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL, Jest, Pactum e2e harness

---

### Task 1: Add failing authorization tests

**Files:**
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts:850-950`
- Modify: `src/circle-plaza/circle-plaza.service.spec.ts:1533-1575`
- Modify: `test/app.factory.ts:1-45`
- Modify: `test/setup-jest.ts:1-20`
- Create: `test/e2e-context.ts`
- Create: `test/circle-plaza-signup.e2e-spec.ts`

- [ ] **Step 1: Add focused service fixtures and tests**

Add an eligible linked-circle marker to both `activePost` and `restrictedPost`,
then search every `signupForPost` mock result and add the marker whenever the
test is meant to reach entitlement or write logic:

```ts
circleLinks: [{ id: 'link-1' }],
```

Add one negative test where `circleLinks` is empty and no existing signup is
present. Assert the exact Nest exception response and absence of downstream
reads or writes:

```ts
await expect(service.signupForPost('user-2', 'post-1')).rejects.toMatchObject({
  response: { errorCode: PlazaErrorCode.PostNotFound },
});
expect(prisma.user.findUnique).not.toHaveBeenCalled();
expect(prisma.circlePostSignup.create).not.toHaveBeenCalled();
```

The same test must assert the complete query contract so membership cannot be
accidentally moved into the broad outer predicate and break idempotency:

```ts
expect(prisma.circlePost.findFirst).toHaveBeenCalledWith({
  where: {
    status: 'ACTIVE',
    OR: [
      { expiresAt: { gt: expect.any(Date) } },
      { expiresAt: null, createdAt: { gt: expect.any(Date) } },
    ],
    id: 'post-1',
    circleLinks: { some: { circle: { deleted: false } } },
  },
  select: expect.objectContaining({
    circleLinks: {
      where: {
        circle: {
          deleted: false,
          members: { some: { userID: 'user-2', status: 'ACTIVE' } },
        },
      },
      select: { id: true },
      take: 1,
    },
  }),
});
```

Extend the existing idempotency test with `circleLinks: []` and keep the
expected `{ signed: true, signupCount: 5 }` response.

- [ ] **Step 2: Add a fail-closed e2e database guard**

In `test/app.factory.ts`, validate before any destructive cleanup:

```ts
export function assertSafeE2eDatabase(
  databaseUrl = process.env.DATABASE_URL,
  nodeEnv = process.env.NODE_ENV,
): void {
  if (nodeEnv !== 'test' || !databaseUrl) {
    throw new Error('E2E cleanup requires NODE_ENV=test and DATABASE_URL');
  }
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!/(^|[_-])test($|[_-])/i.test(databaseName)) {
    throw new Error(`Refusing to clean non-test database: ${databaseName}`);
  }
}
```

Call `assertSafeE2eDatabase()` at the beginning of `initDB()` before
`deleteMany()`. This permits CI's `circle_test` and the local
`circle_signup_test` database but rejects `.env.development`'s
`nestjs_dev_fresh`.

- [ ] **Step 3: Expose the e2e application's Nest container through a typed helper**

Create `test/e2e-context.ts`:

```ts
import type { INestApplication } from '@nestjs/common';

let currentApp: INestApplication | undefined;

export function setE2eApp(app: INestApplication): void {
  currentApp = app;
}

export function clearE2eApp(): void {
  currentApp = undefined;
}

export function getE2eApp(): INestApplication {
  if (!currentApp) throw new Error('E2E application is not initialized');
  return currentApp;
}
```

In `test/setup-jest.ts`, retain the existing lifecycle, call `setE2eApp(app)`
after startup, and call `clearE2eApp()` after closing it. Do not add an untyped
global.

- [ ] **Step 4: Add a PostgreSQL-backed signup authorization matrix**

Create `test/circle-plaza-signup.e2e-spec.ts`. Use this complete structure,
keeping all authorization reads and writes on the real Prisma service:

```ts
import { randomUUID } from 'crypto';
import { CircleMemberStatus } from 'src/generated/prisma';
import { PlazaErrorCode } from 'src/common/app-error-codes';
import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { getE2eApp } from './e2e-context';

describe('CirclePlaza signup membership e2e', () => {
  let prisma: PrismaService;
  let service: CirclePlazaService;
  let ownerId: string;
  let signerId: string;
  let primaryCircleId: string;
  let secondaryCircleId: string;
  let unrelatedCircleId: string;
  let postId: string;

  beforeEach(async () => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    service = app.get(CirclePlazaService);
    jest
      .spyOn(app.get(NotificationService), 'createCirclePostSignupNotification')
      .mockResolvedValue(null);
    jest
      .spyOn(app.get(RealtimeService), 'broadcastSignupUnread')
      .mockResolvedValue(undefined);

    ownerId = randomUUID();
    signerId = randomUUID();
    primaryCircleId = randomUUID();
    secondaryCircleId = randomUUID();
    unrelatedCircleId = randomUUID();
    postId = randomUUID();
    await prisma.user.createMany({
      data: [
        { id: ownerId, accountId: `owner-${ownerId}`, passwordHash: 'x', nickname: 'Owner' },
        { id: signerId, accountId: `signer-${signerId}`, passwordHash: 'x', nickname: 'Signer' },
      ],
    });
    await prisma.circle.createMany({
      data: [
        { id: primaryCircleId, name: 'Primary', ownerID: ownerId, deleted: true },
        { id: secondaryCircleId, name: 'Secondary', ownerID: ownerId },
        { id: unrelatedCircleId, name: 'Unrelated', ownerID: ownerId },
      ],
    });
    await prisma.circlePost.create({
      data: {
        id: postId,
        authorID: ownerId,
        circleID: primaryCircleId,
        content: 'e2e',
        circleLinks: {
          create: [
            { circle: { connect: { id: primaryCircleId } } },
            { circle: { connect: { id: secondaryCircleId } } },
          ],
        },
      },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  async function expectPostNotFound(operation: Promise<unknown>): Promise<void> {
    await expect(operation).rejects.toMatchObject({
      response: { errorCode: PlazaErrorCode.PostNotFound },
    });
    await expect(
      prisma.circlePostSignup.count({ where: { postID: postId, userID: signerId } }),
    ).resolves.toBe(0);
  }

  it('allows an ACTIVE member of a secondary linked circle when primary is deleted', async () => {
    await prisma.circleMember.create({
      data: { userID: signerId, circleID: secondaryCircleId, status: CircleMemberStatus.ACTIVE },
    });
    await expect(service.signupForPost(signerId, postId)).resolves.toEqual({
      signed: true,
      signupCount: 1,
    });
  });

  it.each([CircleMemberStatus.PENDING, CircleMemberStatus.REJECTED] as const)(
    'rejects %s membership',
    async (status) => {
      await prisma.circleMember.create({
        data: { userID: signerId, circleID: secondaryCircleId, status },
      });
      await expectPostNotFound(service.signupForPost(signerId, postId));
    },
  );

  it('rejects membership only in a deleted or unlinked circle', async () => {
    await prisma.circleMember.createMany({
      data: [
        { userID: signerId, circleID: primaryCircleId, status: CircleMemberStatus.ACTIVE },
        { userID: signerId, circleID: unrelatedCircleId, status: CircleMemberStatus.ACTIVE },
      ],
    });
    await expectPostNotFound(service.signupForPost(signerId, postId));
  });

  it('keeps an existing signup idempotent after membership loss', async () => {
    await prisma.circleMember.create({
      data: { userID: signerId, circleID: secondaryCircleId, status: CircleMemberStatus.ACTIVE },
    });
    await service.signupForPost(signerId, postId);
    await prisma.circleMember.update({
      where: { userID_circleID: { userID: signerId, circleID: secondaryCircleId } },
      data: { status: CircleMemberStatus.PENDING },
    });
    await expect(service.signupForPost(signerId, postId)).resolves.toEqual({
      signed: true,
      signupCount: 1,
    });
    await expect(
      prisma.circlePostSignup.count({ where: { postID: postId, userID: signerId } }),
    ).resolves.toBe(1);
    await expect(prisma.circlePost.findUnique({ where: { id: postId } })).resolves.toMatchObject({
      signupCount: 1,
    });
  });
});
```

For every rejection, assert `PlazaErrorCode.PostNotFound` and verify
`circlePostSignup.count({ where: { postID, userID } })` remains zero. For the
idempotency case, assert the second call remains successful and both the signup
row count and denormalized `signupCount` remain one.

- [ ] **Step 5: Run the focused unit test and confirm RED**

Run:

```bash
npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts
```

Expected: the new non-member test fails because the current implementation
does not inspect eligible `circleLinks`; existing unrelated tests remain green.

- [ ] **Step 6: Start a disposable PostgreSQL database and confirm e2e RED**

Use a dedicated container and database name that passes the fail-closed guard:

```bash
docker rm -f circle-signup-test-db 2>/dev/null || true
docker run --name circle-signup-test-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=circle_signup_test \
  -p 55432:5432 -d postgres:16
until docker exec circle-signup-test-db pg_isready -U postgres -d circle_signup_test; do sleep 1; done
NODE_ENV=test \
DATABASE_URL='postgresql://postgres:postgres@localhost:55432/circle_signup_test?schema=public' \
  npx prisma migrate deploy
NODE_ENV=test \
DATABASE_URL='postgresql://postgres:postgres@localhost:55432/circle_signup_test?schema=public' \
  npx jest --config ./test/jest-e2e.json --runInBand test/circle-plaza-signup.e2e-spec.ts
```

Expected: the active-secondary-circle and non-member cases expose the current
primary-circle-only authorization behavior.

Keep the container running for Task 2's GREEN run. Remove it after Task 3:

```bash
docker rm -f circle-signup-test-db
```

### Task 2: Implement the membership guard

**Files:**
- Modify: `src/circle-plaza/circle-plaza.service.ts:631-690`

- [ ] **Step 1: Select an eligible linked circle with the existing post query**

Replace the primary-circle-only condition with a non-deleted linked-circle
existence condition, and select the caller's eligible link:

```ts
where: {
  ...this.activeUnexpiredPostWhere(),
  id: postId,
  circleLinks: { some: { circle: { deleted: false } } },
},
select: {
  id: true,
  authorID: true,
  circleID: true,
  signupVipRestriction: true,
  signupCreditRestriction: true,
  signupFancyRestriction: true,
  circleLinks: {
    where: { circle: this.memberCircleScope(userId) },
    select: { id: true },
    take: 1,
  },
},
```

- [ ] **Step 2: Preserve idempotency, then reject unauthorized new signups**

Keep the existing author rejection and existing-signup fast path unchanged.
Immediately after the fast path, reject an empty eligible relation with the
existing non-disclosing error:

```ts
if (post.circleLinks.length === 0) {
  throw new NotFoundException({
    message: 'Post not found',
    errorCode: PlazaErrorCode.PostNotFound,
  });
}
```

Do not change DTOs, Prisma schema, cancellation behavior, notification flow, or
transaction boundaries.

- [ ] **Step 3: Run focused tests and confirm GREEN**

Run:

```bash
npm test -- --runInBand src/circle-plaza/circle-plaza.service.spec.ts
npx jest --config ./test/jest-e2e.json --runInBand test/circle-plaza-signup.e2e-spec.ts
```

Expected: both suites pass, including the real-relation authorization matrix.

- [ ] **Step 4: Commit the implementation and tests**

```bash
git add src/circle-plaza/circle-plaza.service.ts \
  src/circle-plaza/circle-plaza.service.spec.ts \
  test/app.factory.ts \
  test/setup-jest.ts \
  test/e2e-context.ts \
  test/circle-plaza-signup.e2e-spec.ts
git commit -m "fix(plaza): require membership for new signups"
```

### Task 3: Run production verification

**Files:**
- Verify only

- [ ] **Step 1: Run the complete unit suite without auto-fixing files**

```bash
npm test -- --runInBand
```

Expected: all unit and opt-in integration suites pass or remain explicitly
skipped when their external service URL is absent.

- [ ] **Step 2: Run lint in check-only mode and build**

```bash
npx eslint "{src,apps,libs,test}/**/*.ts"
npm run build
```

Expected: zero lint errors and a successful Nest production build.

- [ ] **Step 3: Inspect the final branch diff**

```bash
git diff --check main...HEAD
git status --short --branch
git diff --stat main...HEAD
```

Expected: no whitespace errors, a clean worktree, and only the scoped design,
plan, service, test-infrastructure, and signup e2e changes.

### Task 4: Retire the obsolete detached worktree

**Files:**
- Remove worktree: `/Users/yiboding/.codex/worktrees/390b/circle_be`

- [ ] **Step 1: Record and back up every detached change**

```bash
mkdir -p /Users/yiboding/.codex/backups
git -C /Users/yiboding/.codex/worktrees/390b/circle_be \
  status --porcelain=v1 --untracked-files=all
git -C /Users/yiboding/.codex/worktrees/390b/circle_be \
  diff --binary > /Users/yiboding/.codex/backups/circle_be-390b-2026-07-12.patch
test -s /Users/yiboding/.codex/backups/circle_be-390b-2026-07-12.patch
git -C /Users/yiboding/.codex/worktrees/390b/circle_be \
  apply --check /Users/yiboding/.codex/backups/circle_be-390b-2026-07-12.patch
```

Expected: exactly four modified tracked files, no untracked files, a non-empty
patch, and a successful `git apply --check` against the detached base.

- [ ] **Step 2: Reconfirm the remaining detached diffs are superseded**

Compare the two friend-chat replay files against `main` and verify the current
lease-token implementation supersedes the old local claim predicate. Confirm
the plaza fix is represented by the new branch implementation and tests.

- [ ] **Step 3: Remove the detached worktree**

```bash
git worktree remove --force /Users/yiboding/.codex/worktrees/390b/circle_be
git worktree prune
```

- [ ] **Step 4: Verify cleanup and backup readability**

```bash
git worktree list --porcelain
git status --short --branch
test -s /Users/yiboding/.codex/backups/circle_be-390b-2026-07-12.patch
```

Expected: the obsolete `390b` worktree is absent, the current feature branch is
clean, and the unrelated detached worktree remains untouched.
