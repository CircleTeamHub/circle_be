# Phase C — Conversation-Group + Chat Review

Branch: `codex/dev-test-logging` → `main`. NestJS production-readiness review.
Scope: `src/conversation-group/*` (full read), plus diffs of `src/note/*`,
`src/openim/openim.service.ts`, `src/upload/*`, and the
`20260515170000_add_conversation_groups` migration.

---

## 1. TL;DR

| # | severity | file:line | description |
|---|----------|-----------|-------------|
| 1 | HIGH | conversation-group.service.ts:113-150 (`setMembers`) | `conversationIDs` membership is never validated against OpenIM ownership — a user can add any conversation ID (including conversations they are not a participant in) to their group. IDOR / cross-user data binding. |
| 2 | MEDIUM | conversation-group.service.ts:152-164 (`ensureOwnership`) + setMembers/update | SELECT-then-write ownership check is outside the `$transaction`; the ownership read for `setMembers` happens before the tx, so a concurrent `remove` can delete the group between check and write. P2025 leaks as raw 500. |
| 3 | MEDIUM | conversation-group.dto.ts:86-97 (`SetConversationGroupMembersDto`) | `conversationIDs` items only validated as non-empty-ish strings (`@IsString`), no `@MaxLength`, no `@ArrayMaxSize`. Unbounded array → unbounded `createMany`; arbitrary-length strings accepted. |
| 4 | MEDIUM | conversation-group.controller.ts (all routes) | No `@Throttle` on any write endpoint; `setMembers`/`create` are spammable DB-write endpoints. |
| 5 | MEDIUM | note.service.ts:622-678 (`updateNoteGroupIds`) | `UpdateNoteGroupIdsDto.groupIds` has no `@ArrayUnique`; dedupe is server-side via `Set` (fine), but `noteGroupMembership.createMany` has no `skipDuplicates` — relies entirely on the prior `deleteMany` + DB PK. Correct only because both run in one tx; noted as fragile. |
| 6 | LOW | conversation-group.service.ts:41-42, 70, 101, 158, 162 | Chinese-language comments and user-facing exception messages (`'同名分组已存在'`, `'分组不存在'`). Inconsistent with English messages elsewhere; client i18n concern. |
| 7 | LOW | conversation-group.controller.ts:42,49,57,68,79 (`@Req() req: any`) | `req` typed `any`; no typed `AuthUser` / `@CurrentUser()` decorator. Pattern B is satisfied functionally but unsafely typed. |
| 8 | LOW | openim.service.ts:197-237 (`post`) | `finally` block calls `logExternalCallSlow` even on the success path after `result` is set — correct, but `Date.now()-start` is recomputed twice (failure log + finally log). Cosmetic. |

No HIGH migration defects. No destructive migration ops.

---

## 2. Per-file walkthrough

### src/conversation-group/conversation-group.controller.ts — OK with notes
- `@UseGuards(JwtGuard)` at class level — every route is authenticated. Good.
- Identity is server-derived: every handler passes `req.user.userId` to the
  service; no `ownerId` in any DTO. **Pattern B satisfied.**
- `ParseUUIDPipe` on `:id` for `update`/`remove`/`setMembers` — good, blocks
  malformed IDs before service.
- **Finding #7 (LOW):** `@Req() req: any` everywhere. Works, but a typo like
  `req.user.userid` would silently yield `undefined` and the service would
  query `ownerID: undefined`. A typed request / `@CurrentUser()` decorator
  removes that class of bug.
- **Finding #4 (MEDIUM):** No `@Throttle`. `POST /conversation-groups` and
  `PUT /:id/members` are unauthenticated-rate DB writers. A script can create
  groups until the `unique([ownerID,name])` space or DB fills. Recommend
  `@Throttle({ default: { limit: 30, ttl: 60_000 } })` on the controller.

### src/conversation-group/conversation-group.service.ts

- `toDto` (23-35): pure mapper, sorts `conversationIDs` for stable diffing.
  No entity leakage. Good.
- `list` (37-46): scoped by `ownerID` from token. Good. Indexed by
  `ConversationGroup_ownerID_idx`. No N+1 — single `findMany` with `include`.
- `create` (48-74): `ownerID` server-derived; P2002 → `ConflictException`.
  Good. `name.trim()` applied. Defaults handled.
- `update` (76-105): calls `ensureOwnership` first, then a single-row
  `update`. **Finding #2:** the `update` can still throw Prisma `P2025`
  (record not found) if the group is deleted between `ensureOwnership` and
  `update` — that path is not caught and surfaces as a raw 500 instead of
  404. Single-table single-row update so no transaction needed, but the
  TOCTOU 500 is a real (if narrow) failure mode.
- `remove` (107-111): ownership check then delete; memberships cascade via FK
  `ON DELETE CASCADE` (confirmed in migration line 36). Good.
- **`setMembers` (113-150) — Finding #1 (HIGH):**
  - The ownership of the *group* is checked (`ensureOwnership`). The ownership
    of each **conversationID being inserted is never checked.** The service
    accepts any string and writes it into `ConversationGroupMembership`.
  - Failure mode: a user puts conversation IDs they are not a member of into
    their own group. Whether this is exploitable depends on how the client/IM
    layer consumes `conversationIDs` — `ConversationGroupDto.conversationIDs`
    is documented as "OpenIM conversationIDs". If any read path uses the group
    membership to *grant access to* or *render* those conversations, this is a
    direct IDOR: attacker enumerates conversation IDs and binds them to a
    group to read others' chats.
  - Even in the benign reading (the group is purely a client-side filter
    label), the table accumulates dangling IDs pointing at conversations the
    owner cannot see — data-integrity rot, and a latent IDOR the moment a read
    path trusts the membership.
  - **Verdict: HIGH** — there is a concrete IDOR failure mode and no
    server-side check that the caller is a participant of each conversation.
    At minimum, validate each `conversationID` against the caller's OpenIM
    conversation list (or a local participants table) before insert. If no
    such source-of-truth exists yet, this endpoint should not ship as-is.
  - **Finding #2 (MEDIUM) cont.:** `ensureOwnership` runs *before*
    `$transaction` (line 118 vs 130). `setMembers` itself is a 2-table-ish
    operation (`deleteMany` + `createMany` on the membership table) correctly
    wrapped in `$transaction` — atomicity within the membership writes is
    fine. But the ownership read is not inside the tx, so a concurrent
    `remove` can delete the group after the check; `findUniqueOrThrow` at
    line 143 then throws `P2025` → raw 500. Move the ownership re-check inside
    the tx (as `note.service.ts:updateNoteGroupIds` correctly does — see
    below) or catch `P2025`.
- `ensureOwnership` (152-164): correctly returns 404 (not 403) for
  not-owned-by-you to avoid existence disclosure. Good security choice.

### src/conversation-group/dto/conversation-group.dto.ts

- `CreateConversationGroupDto`: `@MinLength(1) @MaxLength(32)` on name,
  `@IsInt` / `@IsBoolean` on optionals. Good — **Pattern A satisfied.**
- `UpdateConversationGroupDto`: all optional, validated. Good.
- **`SetConversationGroupMembersDto` (86-97) — Finding #3 (MEDIUM):**
  `@IsArray @IsString({each:true}) @ArrayUnique`. Missing:
  - `@ArrayMaxSize(N)` — array length is unbounded; a 100k-element body goes
    straight into `createMany`.
  - per-item `@MaxLength` — each conversationID can be an arbitrarily long
    string.
  - The `conversationID`s are not UUID-shaped (OpenIM conversation IDs are
    composite strings), so `@IsUUID` is not appropriate — but a sane
    `@MaxLength(128)` and `@ArrayMaxSize(500)` should be added.
  Compare `note.dto.ts UpdateNoteGroupIdsDto` which *does* have
  `@ArrayMaxSize(50)` — apply the same here.

### src/conversation-group/conversation-group.module.ts — OK
Standard wiring; `PrismaService` resolved via the global Prisma module.
Registered in `app.module.ts:58`. Good.

### src/conversation-group/conversation-group.service.spec.ts — OK (with gap)
Covers list/create/update/remove/setMembers happy + ownership-denial paths,
dedupe, clear-all, P2002 translation. `$transaction` mock executes the
callback. Solid. **Gap:** no test asserting that conversation IDs are checked
for caller ownership (because the service does not do it — Finding #1). Once
#1 is fixed, add a "rejects conversationIDs not owned by caller" test.

### prisma/migrations/20260515170000_add_conversation_groups/migration.sql — OK
Verified line-by-line against `schema.prisma` models `ConversationGroup`
(648-661) and `ConversationGroupMembership` (663-671):
- Columns, types, defaults all match (`sortOrder INT DEFAULT 0`,
  `pinnedToTabs BOOLEAN DEFAULT true`, `updatedAt` no default — matches
  `@updatedAt`).
- PK `("groupID","conversationID")` matches `@@id([groupID, conversationID])`
  — this composite PK **is** the dedup/race guard for membership inserts.
- `ConversationGroup_ownerID_name_key` UNIQUE matches `@@unique([ownerID,name])`.
- Both `@@index` present (`ownerID`, `conversationID`).
- FKs: `ConversationGroup.ownerID → User(id) ON DELETE CASCADE`,
  `ConversationGroupMembership.groupID → ConversationGroup(id) ON DELETE
  CASCADE`. Matches schema. `remove()` relying on cascade is correct.
- Pure `CREATE` migration, no `DROP`/`ALTER ... DROP`, non-destructive.
- **Note (not a defect):** there is no FK from
  `ConversationGroupMembership.conversationID` to any table — by design,
  conversation IDs are external OpenIM identifiers. This is *why* Finding #1
  matters: the DB cannot enforce that the conversation exists or belongs to
  the owner; the service must.

### src/note/* (diff only — "note groupIds partial update")
- `UpdateNoteGroupIdsDto` (note.dto.ts): `@IsArray @IsUUID(each)
  @ArrayMaxSize(50)`. **Pattern A satisfied.** groupIds are UUIDs so
  `@IsUUID` is correct here.
- Controller `PATCH :id/groups`: `ParseUUIDPipe` on id, `req.user.userId`
  server-derived. Good.
- `updateNoteGroupIds` (note.service.ts:622-678): **well done.**
  - `requireOwnedGroups` validates every group belongs to the caller before
    any write — this is exactly the check Finding #1 says conversation-group
    is missing.
  - Ownership of the note is **re-verified inside the `$transaction`**
    (`tx.note.findFirst` with `ownerID` + `status != DELETED`) — closes the
    TOCTOU window. This is the pattern conversation-group's `setMembers`
    should copy.
  - `deleteMany` + `createMany` + read all in one tx — atomic.
  - **Finding #5 (MEDIUM, mild):** `createMany` has no `skipDuplicates`.
    Server-side `Set` dedup makes this safe in practice, and the preceding
    `deleteMany` guarantees an empty slate, so a PK collision cannot occur
    within the tx. Acceptable, but `skipDuplicates: true` would be defensive
    parity with `conversation-group.service.ts:140`.
  - Empty-list path correctly skips `createMany` and `requireOwnedGroups`
    short-circuits. Good.
- Tests cover owned/not-owned/dedup/empty/deleted-note. Good.

### src/openim/openim.service.ts (diff only — "OpenIM platform binding")
The diff adds (a) `toImUserId` UUID-hyphen stripping and (b)
external-call logging.
- `toImUserId` (static, line ~74): strips `-` from UUIDs because OpenIM v3.8
  rejects hyphens. Applied consistently at **every** boundary: `registerUser`,
  `getUserToken`, `createGroup` (`memberUserIDs` + `ownerUserID`),
  `inviteUsersToGroup`, `kickUserFromGroup`. Verified all five call sites in
  the diff. Mapping is deterministic and one-way at the boundary; `User.id`
  stays canonical internally. **Correct — no orphan-mapping risk** as long as
  UUIDs are collision-free after hyphen removal (they are; removing fixed
  separators from a UUID preserves uniqueness).
- `post` (197-237): retains `AbortSignal.timeout(5000ms)` — **Pattern F
  timeout preserved.** The new `try/catch/finally`:
  - On failure: `logExternalCallFailure` then `throw error` — error still
    propagates (callers like `auth.service.ts:346` already `.catch()` it
    best-effort). Good.
  - `finally`: `logExternalCallSlow` with `result`. Runs on both paths.
  - **Token-leak check:** `logExternalCallFailure` is passed
    `{ service, operation: path, durationMs, error }` — **no `token`, no
    `body`, no `headers`.** `operation` is the URL path only. The `error`
    object is a `fetch`/abort error or the `new Error('OpenIM error: ...')`
    — does not embed the admin token. **No token leak.** (Assumes the
    `external-service.logger` helper does not re-serialize arbitrary error
    fields verbatim; the logger file is out of scope but the inputs handed to
    it are clean.)
  - **Finding #8 (LOW):** purely cosmetic — `Date.now()-start` computed twice.
- Behavior preserved: `errCode !== 0` still throws. No regression.

### src/upload/* (diff only — "chat upload folder")
- `presign.dto.ts`: adds `'chat'` to `ALLOWED_FOLDERS`. The folder is a
  closed enum validated by `@IsIn(ALLOWED_FOLDERS)` (existing). Low risk —
  just widens an allow-list. Object keys are still server-generated
  (`randomUUID`), so adding the folder cannot be abused for path traversal.
- `upload.service.ts`: wraps `getSignedUrl` in `try/catch/finally` for
  external-call logging — same shape as the OpenIM change. `getSignedUrl`
  failure is logged (`service:'minio'`, `operation:'presign_put_object'`, no
  secrets) and re-thrown. No behavior change to the presign result. Good.

---

## 3. Verified OK

- All conversation-group routes behind `@UseGuards(JwtGuard)`.
- Identity server-derived (`req.user.userId`) on every conversation-group and
  note route — no client-supplied `ownerID`/`userId`. **Pattern B.**
- `setMembers` membership writes wrapped in `$transaction` — atomic clear+insert.
- `note.updateNoteGroupIds` — group-ownership check + in-transaction note
  re-verification — exemplary TOCTOU handling.
- Migration SQL matches `schema.prisma` exactly; non-destructive; correct PK,
  unique, indexes, cascade FKs.
- `create`/`update` translate Prisma P2002 → `ConflictException` (not 500).
- `ensureOwnership` returns 404 (not 403) to avoid existence disclosure.
- OpenIM `post` keeps the 5s `AbortSignal.timeout`; failure logging carries
  no token/body/headers — no secret leak. **Pattern F preserved.**
- `toImUserId` applied at all five OpenIM boundaries consistently.
- Upload folder allow-list remains a closed enum; keys server-generated.
- Global `ValidationPipe` has `whitelist: true` + `transform: true`
  (`setup.ts:168`).

---

## 4. Phase verdict

**Not merge-ready — 1 blocking issue.**

**Blocking (HIGH):**
- **#1** — `setMembers` accepts arbitrary `conversationIDs` with no check that
  the caller participates in those conversations. This is a latent IDOR: the
  membership table can be loaded with conversation IDs the owner does not own,
  and any read path that trusts membership to grant/render conversations
  becomes a cross-user data leak. The DB cannot enforce it (no FK on
  `conversationID` by design), so the service must. `note.updateNoteGroupIds`
  already demonstrates the correct pattern (`requireOwnedGroups`). Either add
  an equivalent participant-ownership check for conversation IDs, or hold the
  endpoint until a source-of-truth for conversation participation exists.

**Should fix before merge (MEDIUM):**
- **#2** — move `setMembers`/`update` ownership check inside the `$transaction`
  (or catch Prisma `P2025`) to avoid a TOCTOU raw-500.
- **#3** — add `@ArrayMaxSize` + per-item `@MaxLength` to
  `SetConversationGroupMembersDto.conversationIDs`.
- **#4** — add `@Throttle` to the conversation-group write endpoints.

**Nice to have:** #5 `skipDuplicates` parity, #6 English messages, #7 typed
request, #8 cosmetic.

The note / OpenIM / upload diffs are **production-ready** as reviewed — no
blocking issues; the OpenIM change correctly preserves the timeout and leaks
no secrets.
