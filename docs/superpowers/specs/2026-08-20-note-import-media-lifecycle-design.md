# Note Import Media Lifecycle Design

## Context

Note imports use deterministic `chat/{viewer}/note-import/{fingerprint}` keys so retries and repeated sends share one object. `collectMediaKeys` consequently excludes every such key from revoke and burn deletion. This avoids breaking surviving messages, but the object is never deleted when its final message disappears, and an import that is copied but never sent has no durable cleanup record.

## Chosen design

Add a durable `ChatMediaReference` row for each `(messageID, objectKey)` note-import reference. A migration will create the table and backfill references from active historical `ChatMessage.content.key` and `thumbKey` values under the note-import namespace. New message creation will persist the message and its references in the same transaction.

Before copying a note-import object, `NoteService` will upsert a delayed `ChatMediaDeletion` reservation. A successful message transaction creates the reference and removes the reservation. A failed or abandoned import remains eligible for the existing deletion worker after the grace period.

Revoke and burn paths will remove message references transactionally. They enqueue an object only when no reference remains. Reference creation, last-reference removal, and deletion claiming will serialize per object key with a transaction-scoped PostgreSQL advisory lock acquired in sorted key order. The deletion worker will recheck references under the same lock immediately before object deletion; if a reference exists, it removes the stale deletion request without touching storage.

Existing non-note chat media remains message-owned and follows the current direct deletion path. No production object scan or deletion is run as part of this change.

## Alternatives considered

1. Generate a random key for every import. Rejected because it reintroduces retry-created orphans and changes multi-send/idempotency behavior.
2. Add a client-provided per-send intent ID. Rejected because it requires a coordinated frontend/API compatibility change and still needs abandoned-intent cleanup.
3. Rely on StorageAudit. Rejected because it is report-only and cannot reconstruct a key after message content is cleared.

## Components and data flow

- Prisma schema and migration: add `ChatMediaReference`, unique `(messageID, objectKey)`, `objectKey` index, message foreign key with cascade, and historical backfill.
- `NoteService.copyNoteMediaForChat`: reserve each deterministic destination key before the external copy; retain partial-success behavior.
- `ChatService.sendMessage`: identify note-import `key`/`thumbKey`, acquire ordered object locks, create references, and clear pending reservations in the message transaction.
- `ChatService.revokeMessage` and burn cleanup: remove references, detect last references, and enqueue deletion in the same transaction that clears message content.
- `ChatMediaService`: claim queued deletion only after a locked reference recheck; referenced objects are never deleted.

## Failure behavior

If reservation persistence fails, the object is not copied. If copying fails, the reservation may safely remain and deleting a missing object is idempotent. If message creation rolls back, neither references nor reservation claims commit. If storage deletion fails, the existing durable retry/dead-letter behavior remains. Hash collisions in advisory locks may add contention but cannot weaken correctness.

## Testing

- Add RED Prisma/service tests for reservation-before-copy and no-copy-on-reservation-failure.
- Add RED chat tests proving two messages may share an object, revoking one preserves it, and revoking/burning the last reference queues deletion.
- Add a RED deletion-worker race test proving a referenced object is not deleted even when a stale deletion row is due.
- Add a migration contract/backfill test for both `key` and `thumbKey` and exclusion of revoked/deleted rows.
- Run Prisma validation/generation, focused note/chat/media tests, typecheck, focused lint, migration checks, and `git diff --check`.

## Success criteria

- Every new note-import copy has a durable cleanup path before storage mutation.
- Every committed note-import message has durable object references.
- Shared objects survive until the final active message reference disappears.
- A stale or raced deletion request cannot delete a referenced object.
- Existing note-import message references are backfilled without changing message payloads or client APIs.
