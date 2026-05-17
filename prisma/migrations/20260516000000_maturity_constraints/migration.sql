-- Maturity playbook §3 — DB-level invariant backstops.
-- All statements are additive and idempotent (IF NOT EXISTS); none drop data.
-- Idempotency matters: the shared dev database already carries some of these
-- objects from a parallel branch, so a re-run must be a no-op for those.

-- ── New columns ──────────────────────────────────────────────────────────────

-- One-time friend-activity backfill marker (replaces the per-read backfill).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "activitiesBackfilledAt" TIMESTAMP(3);

-- Idempotency key for coin gifts — a retried POST /coin/gift reuses it and is
-- rejected by the unique index below instead of double-charging.
ALTER TABLE "CoinGift" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- ── Plain unique constraints (Prisma-managed, declared in schema.prisma) ──────

-- Dedup friend reports: one report per (reporter, target, category).
CREATE UNIQUE INDEX IF NOT EXISTS "FriendReport_reporterID_targetID_category_key"
  ON "FriendReport"("reporterID", "targetID", "category");

-- One activity row per (request, viewer, type) — makes the inbox backfill and
-- createMany idempotent under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS "FriendActivity_requestId_viewerId_type_key"
  ON "FriendActivity"("requestId", "viewerId", "type");

-- Idempotency key uniqueness (Postgres allows multiple NULLs, so legacy gifts
-- without a key are unaffected).
CREATE UNIQUE INDEX IF NOT EXISTS "CoinGift_idempotencyKey_key"
  ON "CoinGift"("idempotencyKey");

-- ── Partial unique indexes (raw SQL — not expressible in schema.prisma) ───────

-- At most one ACTIVE/PENDING friendship per unordered user pair. LEAST/GREATEST
-- normalizes direction so A→B and B→A collide.
CREATE UNIQUE INDEX IF NOT EXISTS "Friend_active_pair_key"
  ON "Friend"(LEAST("userID", "friendID"), GREATEST("userID", "friendID"))
  WHERE "state" IN ('PENDING', 'ACCEPTED');

-- At most one PENDING invitation per (circle, applicant).
CREATE UNIQUE INDEX IF NOT EXISTS "CircleInvitation_pending_applicant_key"
  ON "CircleInvitation"("circleID", "applicantID")
  WHERE "status" = 'PENDING';

-- At most one live (non-deleted) note group per (owner, name). Partial so a
-- soft-deleted name can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS "NoteGroup_owner_name_active_key"
  ON "NoteGroup"("ownerID", "name")
  WHERE "deletedAt" IS NULL;
