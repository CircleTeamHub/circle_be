# User QR Rotation Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop USER QR rotation from inserting an unbounded permanent history while keeping explicit rotation semantics.

**Architecture:** Serialize by the existing advisory lock, reuse a token created within 60 seconds, and otherwise update the newest active row in place. Create a row only when no active USER token exists.

**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL advisory locks, Jest.

## Global Constraints

- A retry within 60 seconds returns the same token.
- A rotation after 60 seconds invalidates the old token by updating its row in place.
- No normal rotation inserts a revoked history row.
- Preserve USER token type, self target/issuer, and non-expiring DTO semantics.

---

### Task 1: Make USER rotation idempotent and bounded

**Files:**
- Modify: `src/qr/qr.service.ts:83-107`
- Test: `src/qr/qr.service.spec.ts:211-243`

**Interfaces:**
- Consumes: newest active USER token `{ id, token, createdAt }` after `lockTokenKey`.
- Produces: an existing token inside the retry window, otherwise one `qrToken.update` or `qrToken.create`.

- [x] **Step 1: Write failing tests for retry and in-place rotation**

```ts
it('returns the current token when rotation is retried within 60 seconds', async () => {
  prisma.qrToken.findFirst.mockResolvedValue({
    id: 'qr-1', token: 'same-token', createdAt: new Date(Date.now() - 30_000),
  });
  await expect(service.rotateUserToken('u1')).resolves.toMatchObject({ token: 'same-token' });
  expect(prisma.qrToken.update).not.toHaveBeenCalled();
  expect(prisma.qrToken.create).not.toHaveBeenCalled();
});

it('updates an older active USER token in place', async () => {
  prisma.qrToken.findFirst.mockResolvedValue({
    id: 'qr-1', token: 'old-token', createdAt: new Date(Date.now() - 61_000),
  });
  await service.rotateUserToken('u1');
  expect(prisma.qrToken.update).toHaveBeenCalledWith({
    where: { id: 'qr-1' },
    data: { token: expect.any(String), createdAt: expect.any(Date), revokedAt: null },
  });
  expect(prisma.qrToken.create).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- --runInBand qr/qr.service.spec.ts -t "rotateUserToken"`

Expected: FAIL because the current code revokes and inserts every time.

- [x] **Step 3: Implement locked reuse/update/create flow**

```ts
const current = await tx.qrToken.findFirst({
  where: { type: 'USER', targetID: userId, issuerID: userId, revokedAt: null },
  orderBy: { createdAt: 'desc' },
  select: { id: true, token: true, createdAt: true },
});
if (current && Date.now() - current.createdAt.getTime() < 60_000) {
  return { token: current.token, type: 'USER', expiresAt: null };
}
const token = randomBytes(24).toString('base64url');
if (current) {
  await tx.qrToken.update({
    where: { id: current.id },
    data: { token, createdAt: new Date(), revokedAt: null },
  });
} else {
  await tx.qrToken.create({
    data: { token, type: 'USER', targetID: userId, issuerID: userId, expiresAt: null },
  });
}
```

- [x] **Step 4: Run focused verification**

Run: `npm test -- --runInBand qr/qr.service.spec.ts`

Expected: PASS.

- [x] **Step 5: Review and commit**

```bash
git diff --check
git add src/qr/qr.service.ts src/qr/qr.service.spec.ts docs/superpowers/plans/2026-08-18-user-qr-rotation-retention.md
git commit -m "fix(qr): bound user token rotation history"
```
