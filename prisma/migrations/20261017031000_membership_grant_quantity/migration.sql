ALTER TABLE "MembershipGrant" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "MembershipGrant" ADD CONSTRAINT "MembershipGrant_quantity_check" CHECK ("quantity" BETWEEN 1 AND 30 AND ("quantity" = 1 OR "planId" = 'daily'));
