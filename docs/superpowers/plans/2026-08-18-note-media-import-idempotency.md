# Note Media Import Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated note-to-chat media imports reuse one destination key instead of creating permanent random orphan objects.

**Architecture:** Derive the destination filename from immutable source identity plus viewer scope using SHA-256. Keep the existing copy API and partial-failure response contract unchanged.

**Tech Stack:** NestJS, TypeScript, Node `crypto`, Prisma, Jest, S3-compatible object storage.

## Global Constraints

- Destination keys stay under `chat/{viewerID}/note-import/`.
- The same viewer, note, media row, and source object key always produce the same key.
- Different viewers or source media produce different keys.
- Do not add a schema migration or change the API DTO.

---

### Task 1: Replace random destinations with deterministic keys

**Files:**
- Modify: `src/note/note.service.ts:2028-2034`
- Test: `src/note/note.service.spec.ts:3588-3735`

**Interfaces:**
- Consumes: `viewerID`, `noteId`, `NoteMediaRow.id`, and `NoteMediaRow.objectKey`.
- Produces: a 64-hex-character SHA-256 destination filename with the existing lowercase extension.

- [x] **Step 1: Write the failing retry test**

```ts
it('reuses the same destination key when an import request is retried', async () => {
  prisma.note.findFirst.mockResolvedValue(noteRow());
  await service.copyNoteMediaForChat('viewer-2', 'note-1', ['media']);
  await service.copyNoteMediaForChat('viewer-2', 'note-1', ['media']);
  expect(uploadService.copyObjectToKey.mock.calls[0][1]).toBe(
    uploadService.copyObjectToKey.mock.calls[1][1],
  );
  expect(uploadService.copyObjectToKey.mock.calls[0][1]).toMatch(
    /^chat\/viewer-2\/note-import\/[0-9a-f]{64}\.jpg$/,
  );
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- --runInBand note/note.service.spec.ts -t "reuses the same destination key"`

Expected: FAIL because two UUID destinations differ.

- [x] **Step 3: Implement deterministic destination derivation**

```ts
const fingerprint = createHash('sha256')
  .update(viewerID)
  .update('\0')
  .update(noteId)
  .update('\0')
  .update(row.id)
  .update('\0')
  .update(row.objectKey)
  .digest('hex');
const destKey = `${CHAT_MEDIA_KEY_PREFIX}${viewerID}/note-import/${fingerprint}${
  ext ? `.${ext.toLowerCase()}` : ''
}`;
```

- [x] **Step 4: Run focused verification**

Run: `npm test -- --runInBand note/note.service.spec.ts -t "copyNoteMediaForChat"`

Expected: PASS.

- [x] **Step 5: Review and commit**

```bash
git diff --check
git add src/note/note.service.ts src/note/note.service.spec.ts docs/superpowers/plans/2026-08-18-note-media-import-idempotency.md
git commit -m "fix(note): make chat media imports idempotent"
```
