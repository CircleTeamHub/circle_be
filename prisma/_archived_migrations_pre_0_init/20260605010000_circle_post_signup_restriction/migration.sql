-- AlterTable
ALTER TABLE "CirclePost" ADD COLUMN     "signupCreditRestriction" INTEGER,
ADD COLUMN     "signupFancyRestriction" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signupVipRestriction" INTEGER;

