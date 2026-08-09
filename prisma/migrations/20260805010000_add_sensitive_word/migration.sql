BEGIN;

CREATE TABLE "SensitiveWord" (
  "id" TEXT NOT NULL,
  "word" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT,

  CONSTRAINT "SensitiveWord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SensitiveWord_word_key"
ON "SensitiveWord" ("word");

COMMIT;
