-- Trace moments feed: switch to keyset pagination backed by a composite index.
--
-- The feed filters by `fromID IN (...)` and orders by `createdAt DESC`. With only
-- the single-column `Trace_fromID_idx`, Postgres fetches by author then does a
-- top-N heapsort whose work grows with page depth (offset). The composite index
-- lets the keyset query (`ORDER BY createdAt DESC, id DESC`) read rows in order
-- straight from the index — depth-independent cost. `fromID` remains the leading
-- column, so it still covers the old fromID-only lookups; the single-column index
-- is therefore redundant and dropped.

DROP INDEX "Trace_fromID_idx";

CREATE INDEX "Trace_fromID_createdAt_idx" ON "Trace"("fromID", "createdAt" DESC);
