-- Note ratings (好评 / 差评): rating events, the per-note daily cap rows, the
-- per-month displayed counters and the admin review cases (burst holds, appeals).
-- All tables are new and empty, so plain CREATE INDEX is fine here.
-- NoteRating."noteID" deliberately has no foreign key: ratings outlive a hard
-- purge of the root note for audit and appeals.
-- CreateEnum
CREATE TYPE "NoteRatingValue" AS ENUM ('GOOD', 'BAD');

-- CreateEnum
CREATE TYPE "NoteRatingReason" AS ENUM ('INACCURATE', 'EXPIRED', 'BAD_EXPERIENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "NoteRatingStatus" AS ENUM ('COUNTED', 'HELD', 'VOID');

-- CreateEnum
CREATE TYPE "NoteRatingCaseKind" AS ENUM ('BURST', 'APPEAL');

-- CreateEnum
CREATE TYPE "NoteRatingCaseStatus" AS ENUM ('PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "NoteRatingCaseResolution" AS ENUM ('RELEASE', 'VOID', 'UPHOLD', 'REVOKE');

-- CreateTable
CREATE TABLE "NoteRating" (
    "id" TEXT NOT NULL,
    "noteID" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "raterID" TEXT NOT NULL,
    "value" "NoteRatingValue" NOT NULL,
    "reason" "NoteRatingReason",
    "comment" VARCHAR(200),
    "status" "NoteRatingStatus" NOT NULL DEFAULT 'COUNTED',
    "ratedDay" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteRatingDaily" (
    "noteID" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "goodCount" INTEGER NOT NULL DEFAULT 0,
    "badCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NoteRatingDaily_pkey" PRIMARY KEY ("noteID","day")
);

-- CreateTable
CREATE TABLE "NoteRatingMonthly" (
    "noteID" TEXT NOT NULL,
    "month" CHAR(7) NOT NULL,
    "goodCount" INTEGER NOT NULL DEFAULT 0,
    "badCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NoteRatingMonthly_pkey" PRIMARY KEY ("noteID","month")
);

-- CreateTable
CREATE TABLE "NoteRatingCase" (
    "id" TEXT NOT NULL,
    "kind" "NoteRatingCaseKind" NOT NULL,
    "status" "NoteRatingCaseStatus" NOT NULL DEFAULT 'PENDING',
    "ownerID" TEXT NOT NULL,
    "ownerReason" VARCHAR(500),
    "resolution" "NoteRatingCaseResolution",
    "resolutionNote" VARCHAR(500),
    "resolvedByID" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteRatingCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteRatingCaseItem" (
    "caseID" TEXT NOT NULL,
    "ratingID" TEXT NOT NULL,

    CONSTRAINT "NoteRatingCaseItem_pkey" PRIMARY KEY ("caseID","ratingID")
);

-- CreateIndex
CREATE INDEX "NoteRating_raterID_createdAt_idx" ON "NoteRating"("raterID", "createdAt");

-- CreateIndex
CREATE INDEX "NoteRating_raterID_noteID_createdAt_idx" ON "NoteRating"("raterID", "noteID", "createdAt");

-- CreateIndex
CREATE INDEX "NoteRating_noteID_createdAt_idx" ON "NoteRating"("noteID", "createdAt");

-- CreateIndex
CREATE INDEX "NoteRating_ownerID_createdAt_idx" ON "NoteRating"("ownerID", "createdAt");

-- CreateIndex
CREATE INDEX "NoteRating_raterID_ownerID_value_createdAt_idx" ON "NoteRating"("raterID", "ownerID", "value", "createdAt");

-- CreateIndex
CREATE INDEX "NoteRatingCase_status_kind_createdAt_idx" ON "NoteRatingCase"("status", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "NoteRatingCase_ownerID_kind_createdAt_idx" ON "NoteRatingCase"("ownerID", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "NoteRatingCaseItem_ratingID_idx" ON "NoteRatingCaseItem"("ratingID");

-- AddForeignKey
ALTER TABLE "NoteRating" ADD CONSTRAINT "NoteRating_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteRating" ADD CONSTRAINT "NoteRating_raterID_fkey" FOREIGN KEY ("raterID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteRatingCase" ADD CONSTRAINT "NoteRatingCase_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteRatingCase" ADD CONSTRAINT "NoteRatingCase_resolvedByID_fkey" FOREIGN KEY ("resolvedByID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteRatingCaseItem" ADD CONSTRAINT "NoteRatingCaseItem_caseID_fkey" FOREIGN KEY ("caseID") REFERENCES "NoteRatingCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteRatingCaseItem" ADD CONSTRAINT "NoteRatingCaseItem_ratingID_fkey" FOREIGN KEY ("ratingID") REFERENCES "NoteRating"("id") ON DELETE CASCADE ON UPDATE CASCADE;

