# PM Backend Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the server-side contracts required by the PM change batch: six-hour post expiry, moderator-only group-wide history clearing, durable group audit notices, and account-synced direct-message auto replies.

**Architecture:** Extend the existing NestJS/Prisma modules instead of introducing parallel APIs. Group-wide clearing continues to use per-member watermarks, group logs remain ordinary persisted `system` chat messages, and direct-message auto replies use a durable inbox plus a database cooldown state so they work while the mobile app is offline without duplicate replies.

**Tech Stack:** NestJS 11, TypeScript, Prisma 7, PostgreSQL, Socket.IO, Jest.

**Status (2026-09-04):** Implemented and verified. All focused backend suites pass; the full unit suite has two unrelated Windows/ACL environment failures documented in the pull request.

## Global Constraints

- Group-wide clearing is restricted to the standalone-group owner or an active circle OWNER/ADMIN.
- Message rows remain retained for audit; clearing advances active members' visibility/read watermarks.
- Auto reply is disabled by default, text is limited to 200 characters, and the same responder may reply at most once per direct conversation every 30 seconds.
- All server-generated chat messages use deterministic idempotency keys and are broadcast only after their transaction commits.
- Existing mobile API routes and response shapes remain backward compatible.

---

### Task 1: Six-hour circle-post expiry

**Files:**
- Modify: `src/circle-plaza/dto/circle-plaza.dto.ts`
- Modify: `src/circle-plaza/circle-plaza.service.ts`
- Test: `src/circle-plaza/circle-plaza.service.spec.ts`

**Interfaces:**
- Consumes: `CreateCirclePostDto.expiresInHours?: number`.
- Produces: a default of `6` hours and an accepted range of `6..168` hours.

- [x] **Step 1: Write the failing tests**

```ts
it('defaults to a 6h expiry when expiresInHours is omitted', async () => {
  await service.createPost('user-1', baseDto);
  expect(prisma.circlePost.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ expiresAt: sixHoursLater }) }),
  );
});

it('accepts an explicit 6 hour expiry', () => {
  expect(validateSync(plainToInstance(CreateCirclePostDto, { expiresInHours: 6 }))).toHaveLength(0);
});
```

- [x] **Step 2: Run the focused test and verify it fails because the current default/minimum is 24**

Run: `npx jest src/circle-plaza/circle-plaza.service.spec.ts --runInBand`

- [x] **Step 3: Change `DEFAULT_CIRCLE_POST_EXPIRY_HOURS` and DTO metadata/validation to 6**

```ts
const DEFAULT_CIRCLE_POST_EXPIRY_HOURS = 6;

@ApiPropertyOptional({ description: 'Post lifetime in hours. Min 6h, max 168h.', default: 6 })
@Min(6)
expiresInHours?: number;
```

- [x] **Step 4: Re-run the focused test and verify it passes**

Run: `npx jest src/circle-plaza/circle-plaza.service.spec.ts --runInBand`

### Task 2: Moderator-only group-wide history clearing

**Files:**
- Modify: `src/chat/chat.service.ts`
- Modify: `src/chat/chat.controller.ts`
- Modify: `src/chat/chat.constants.ts`
- Modify: `src/chat/chat.types.ts`
- Test: `src/chat/chat.service.spec.ts`
- Test: `src/chat/chat-broadcast.service.spec.ts`

**Interfaces:**
- Consumes: `POST /chat/conversations/:id/clear` with `{ forEveryone: true }`.
- Produces: `{ clearedBeforeHeight }`, a `chat:history_cleared` room broadcast, and a visible `history-cleared` system log entry.

- [x] **Step 1: Add failing authorization and fan-out tests**

```ts
it('lets a standalone group owner clear all active member watermarks', async () => {
  await service.clearHistory('owner-1', 'conv-1', true);
  expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ leftAt: null }) }),
  );
});

it('rejects group-wide clearing by a regular member', async () => {
  await expect(service.clearHistory('member-1', 'conv-1', true)).rejects.toBeInstanceOf(ForbiddenException);
});
```

- [x] **Step 2: Run the chat service test and observe the group fan-out test fail**

Run: `npx jest src/chat/chat.service.spec.ts --runInBand`

- [x] **Step 3: Implement permission checks and active-member watermark fan-out**

```ts
const globalClear = forEveryone && member.conversation.type !== 'TEMP';
if (globalClear && member.conversation.type === 'GROUP') {
  await this.assertCanClearGroupForEveryone(member.conversation, userId);
}
```

For global clearing, update only `leftAt: null` members, advance `clearedBeforeHeight` and `lastReadHeight`, broadcast each read watermark, then emit `chat:history_cleared` and a `history-cleared` system message after the watermark so the audit event remains visible.

- [x] **Step 4: Re-run focused chat tests**

Run: `npx jest src/chat/chat.service.spec.ts src/chat/chat-broadcast.service.spec.ts --runInBand`

### Task 3: Complete persisted group-log events

**Files:**
- Modify: `src/circle/circle.service.ts`
- Modify: `src/group/group.service.ts`
- Test: `src/circle/circle.service.spec.ts`
- Test: `src/group/group.service.spec.ts`

**Interfaces:**
- Consumes: existing circle updates, role changes, and member removal commands.
- Produces: persisted `system` messages with kinds `group-notice-updated`, `member-role-changed`, and `member-removed`.

- [x] **Step 1: Add failing tests for each missing audit event**

```ts
expect(systemMessage.insertSystemMessageInTx).toHaveBeenCalledWith(
  prisma,
  'conv-1',
  expect.objectContaining({ kind: 'group-notice-updated', actorId: 'owner-1' }),
);
```

Role-change and removal tests assert actor ID, target ID, new role, transaction persistence, and post-commit broadcast. Removal broadcasts only after the removed member has left the Socket.IO room.

- [x] **Step 2: Run circle/group tests and verify the new expectations fail**

Run: `npx jest src/circle/circle.service.spec.ts src/group/group.service.spec.ts --runInBand`

- [x] **Step 3: Inject `ChatSystemMessageService` and persist audit messages in the existing mutation transactions**

```ts
const notice = await this.systemMessage.insertSystemMessageInTx(tx, conversationId, {
  kind: 'member-role-changed',
  actorId,
  targetUserId,
  role: nextRole,
});
```

- [x] **Step 4: Broadcast returned notices after commit and verify focused tests pass**

Run: `npx jest src/circle/circle.service.spec.ts src/group/group.service.spec.ts --runInBand`

### Task 4: Durable account-synced direct-message auto reply

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260904050000_add_direct_auto_reply/migration.sql`
- Modify: `src/privacy/privacy-settings.dto.ts`
- Modify: `src/privacy/privacy-settings.service.ts`
- Modify: `src/chat/chat.service.ts`
- Create: `src/chat/chat-direct-auto-reply.processor.ts`
- Create: `src/chat/chat-direct-auto-reply.processor.spec.ts`
- Modify: `src/chat/chat.module.ts`
- Test: `src/privacy/privacy-settings.service.spec.ts`
- Test: `src/chat/chat.service.spec.ts`

**Interfaces:**
- Consumes: `PATCH /privacy/settings` with `directMessageAutoReplyEnabled` and `directMessageAutoReplyText`.
- Produces: the same fields from `GET /privacy/settings`, durable `ChatDirectAutoReplyJob` rows, and server-authored text messages carrying `{ text, autoReply: true }`.

- [x] **Step 1: Add failing DTO/service tests for defaults, persistence, trimming, and 200-character validation**

```ts
expect(await service.getSettings('user-1')).toMatchObject({
  directMessageAutoReplyEnabled: false,
  directMessageAutoReplyText: '',
});
```

- [x] **Step 2: Add failing chat tests for durable job creation and processor behavior**

Tests cover: direct messages enqueue one unique job; group/server messages do not; disabled/blank settings skip; enabled settings reply as the peer; a deterministic idempotency key prevents replay duplicates; and the database cooldown suppresses a second reply within 30 seconds.

- [x] **Step 3: Run the focused tests and verify failures are due to missing schema/API/processor behavior**

Run: `npx jest src/privacy/privacy-settings.service.spec.ts src/chat/chat.service.spec.ts src/chat/chat-direct-auto-reply.processor.spec.ts --runInBand`

- [x] **Step 4: Add the Prisma fields, durable job/state models, and migration**

```prisma
directMessageAutoReplyEnabled Boolean @default(false)
directMessageAutoReplyText    String  @default("") @db.VarChar(200)
```

The migration also creates a unique source-message job inbox and a unique `(conversationID, responderID)` cooldown state.

- [x] **Step 5: Implement validated settings serialization and the durable processor**

The incoming message transaction creates the job. The processor claims it, locks the conversation, rechecks the current preference, inserts the reply and cooldown state atomically, then broadcasts/pushes after commit. Failed jobs retry with bounded exponential backoff and retain a redacted error summary.

- [x] **Step 6: Generate Prisma client and verify focused tests pass**

Run: `npx prisma generate`

Run: `npx jest src/privacy/privacy-settings.service.spec.ts src/chat/chat.service.spec.ts src/chat/chat-direct-auto-reply.processor.spec.ts --runInBand`

### Task 5: Cross-repository client integration and verification

**Files:**
- Modify in frontend: `src/services/api/privacy.ts`
- Modify in frontend: `src/features/profile/store/use-direct-message-auto-reply-store.ts`
- Modify in frontend: `src/features/profile/screens/DirectMessageAutoReplyScreen.tsx`
- Modify in frontend: `src/chat-core/dispatcher.ts`
- Modify in frontend: `src/chat-core/message-mappers.ts`
- Modify in frontend: `docs/pm-change-checklist.md`
- Test in frontend: `test/pm-change-batch.test.js`

**Interfaces:**
- Consumes: backend privacy fields and new system-message kinds.
- Produces: server-synced settings, no duplicate client-side auto replies, and localized group-log labels.

- [x] **Step 1: Add failing frontend contract tests**

Tests require auto-reply settings to use `GET/PATCH /privacy/settings`, ensure the dispatcher no longer sends a second local reply, and map every new group audit kind.

- [x] **Step 2: Implement minimal client integration and translations**

Keep local draft UI state only; backend response is authoritative. Existing clients remain compatible because the added response fields are optional to older builds.

- [x] **Step 3: Run backend and frontend verification**

Backend: `npm run build`, focused Jest suites, then `npm test -- --runInBand` with the two known Windows-only baseline failures called out separately.

Frontend: `npm run typecheck`, `npm run lint`, `node --test test/pm-change-batch.test.js`.

- [x] **Step 4: Review diffs and update the checklist with frontend/backend completion state**

Run `git diff --check` and inspect both repository diffs before making any completion claim.
