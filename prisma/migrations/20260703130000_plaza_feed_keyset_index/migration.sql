-- Plaza feed keyset pagination: composite index on (status, createdAt DESC, id DESC).
--
-- The feed always filters `status='ACTIVE'` and orders by `createdAt DESC, id DESC`.
-- With only (circleID, createdAt) / (status, expiresAt), Postgres top-N heapsorts
-- the membership-scoped candidate set every page. This index makes `status`
-- equality + the full sort tuple a pure index scan — no sort step — and stays
-- status-aware so it does not degrade as ENDED/DELETED posts accumulate.

CREATE INDEX IF NOT EXISTS "CirclePost_status_createdAt_id_idx" ON "CirclePost"("status", "createdAt" DESC, "id" DESC);
