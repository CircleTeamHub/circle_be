# Note Status Fan-out Outbox Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move note source-status fan-out out of synchronous write requests while preserving durable delivery, bounded work, and indexed recipient discovery.

**Architecture:** Status mutations update the note and upsert a coalescing outbox row in the same database transaction. Notes and note-card messages retain an indexed canonical root-note identifier. A leased cron processor reads the latest root state and advances through owner and chat-recipient pages with durable cursors; concurrent newer mutations increment a generation so stale workers cannot complete or overwrite the replacement job.

**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL, Jest, Prometheus outbox metrics

---

## Task 1: Lock the request-path and indexing contract with failing tests

**Files:**

- Modify: `src/note/note.service.spec.ts`
- Modify: `src/chat/chat.service.spec.ts`
- Create: `src/note/note-status-fanout-outbox.processor.spec.ts`

- [x] Replace the synchronous broadcast test with a test proving a note mutation and outbox upsert share one transaction and do not query recipients or call realtime.
- [x] Assert note-card persistence copies only the server-resolved `sourceNoteId` into the indexed `sourceNoteID` column and never trusts a forged client root.
- [x] Add processor tests for bounded owner pages, bounded active chat-member pages, progress cursors, retries, stale lease recovery, and generation fencing.
- [x] Run the focused tests and confirm they fail because the new schema and processor do not exist yet.

## Task 2: Add denormalized root keys and the durable outbox schema

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261020000000_add_note_status_fanout_outbox/migration.sql`

- [x] Add `Note.rootSourceNoteID`, populated on collected copies, with an index that supports root-family pagination.
- [x] Add `ChatMessage.sourceNoteID`, populated only from server-resolved card provenance, with a partial `(sourceNoteID, conversationID)` index for live note cards.
- [x] Backfill both columns from existing collect chains and note-card JSON without changing user-visible data.
- [x] Add a coalescing `NoteStatusFanoutOutbox` model with status, stage, generation, lease, retry, and explicit pagination cursors.
- [x] Generate the Prisma client and validate/format the schema.

## Task 3: Make note status writes transactional and constant-cost

**Files:**

- Modify: `src/note/note.service.ts`

- [x] Add a transaction-scoped enqueue helper that resets progress, increments generation, and clears any old lease.
- [x] Change availability, work-status, publication-status, restore, and soft-delete mutations to write the note and outbox atomically.
- [x] Remove the synchronous ancestry, descendants, JSON message, membership, and realtime fan-out from `NoteService`.
- [x] Preserve existing response shapes and authorization/TOCTOU guards.

## Task 4: Maintain root provenance on new data

**Files:**

- Modify: `src/note/note.service.ts`
- Modify: `src/chat/chat.service.ts`

- [x] Stamp collected notes with `source.rootSourceNoteID ?? source.id`.
- [x] Persist `ChatMessage.sourceNoteID` from the already server-sanitized note-card content.
- [x] Keep unresolvable or unauthorized cards nullable so client input cannot become an indexed authorization oracle.

## Task 5: Process fan-out in durable bounded pages

**Files:**

- Create: `src/note/note-status-fanout-outbox.processor.ts`
- Modify: `src/note/note.module.ts`

- [x] Claim pending, failed, or stale jobs with a random lease token and the observed generation.
- [x] Broadcast one bounded page of source/copy owners, then persist the note cursor and release the lease.
- [x] Broadcast one bounded page of active chat members selected through indexed note-card provenance, then persist the composite chat cursor.
- [x] Read the latest root state for every page; represent a purged root as deleted/unavailable.
- [x] Fence every progress, retry, and completion write by root key, generation, lease token, and processing status.
- [x] Retry failures with capped exponential backoff and sanitized structured diagnostics.

## Task 6: Expose queue health and verify production behavior

**Files:**

- Modify: `src/metrics/outbox-depth.service.ts`
- Modify: `src/metrics/outbox-depth.service.spec.ts`
- Modify: `docs/superpowers/plans/2026-10-20-note-status-fanout-outbox.md`

- [x] Register the new queue in outbox depth metrics using the same retry-state definition as the processor.
- [x] Run focused Jest suites for note, chat, processor, and metrics behavior.
- [x] Run Prisma validation/generation, typecheck/build, lint on changed files or the repository command, and the relevant broader test suite.
- [x] Review the final diff for accidental API shape changes, unbounded queries, unsafe logs, and migration deployability.
- [x] Mark all completed checklist items and create one clear local commit on the isolated `codex/` branch.
