-- The ledger revert primitives were removed; revertedAt was never written.
ALTER TABLE "CreditEvent" DROP COLUMN "revertedAt";
