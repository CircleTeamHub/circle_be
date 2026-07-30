SET lock_timeout = '5s';

BEGIN;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "selectedAvatarFrameID" TEXT,
  ADD COLUMN IF NOT EXISTS "selectedAvatarFrameExpiresAt" TIMESTAMP(3);

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS "AvatarFrameAsset" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "imageUrl" TEXT,
  "minimumVipLevel" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AvatarFrameAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AvatarFrameAsset_minimumVipLevel_check"
    CHECK ("minimumVipLevel" IS NULL OR "minimumVipLevel" BETWEEN 1 AND 4)
);

CREATE TABLE IF NOT EXISTS "UserAvatarFrameGrant" (
  "id" TEXT NOT NULL,
  "userID" TEXT NOT NULL,
  "frameID" TEXT NOT NULL,
  "operatorUserID" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedByUserID" TEXT,
  "revokeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserAvatarFrameGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AvatarFrameAsset_key_key"
  ON "AvatarFrameAsset"("key");
CREATE INDEX IF NOT EXISTS "AvatarFrameAsset_isActive_sortOrder_id_idx"
  ON "AvatarFrameAsset"("isActive", "sortOrder", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "UserAvatarFrameGrant_idempotencyKey_key"
  ON "UserAvatarFrameGrant"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "UserAvatarFrameGrant_user_active_idx"
  ON "UserAvatarFrameGrant"("userID", "revokedAt", "expiresAt");
CREATE INDEX IF NOT EXISTS "UserAvatarFrameGrant_user_createdAt_id_idx"
  ON "UserAvatarFrameGrant"("userID", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "UserAvatarFrameGrant_frame_active_idx"
  ON "UserAvatarFrameGrant"("frameID", "revokedAt", "expiresAt");
CREATE INDEX IF NOT EXISTS "UserAvatarFrameGrant_operatorUserID_createdAt_idx"
  ON "UserAvatarFrameGrant"("operatorUserID", "createdAt");
CREATE INDEX IF NOT EXISTS "UserAvatarFrameGrant_revokedByUserID_revokedAt_idx"
  ON "UserAvatarFrameGrant"("revokedByUserID", "revokedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'UserAvatarFrameGrant_userID_fkey'
      AND conrelid = '"UserAvatarFrameGrant"'::regclass
  ) THEN
    ALTER TABLE "UserAvatarFrameGrant"
      ADD CONSTRAINT "UserAvatarFrameGrant_userID_fkey"
      FOREIGN KEY ("userID") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'UserAvatarFrameGrant_frameID_fkey'
      AND conrelid = '"UserAvatarFrameGrant"'::regclass
  ) THEN
    ALTER TABLE "UserAvatarFrameGrant"
      ADD CONSTRAINT "UserAvatarFrameGrant_frameID_fkey"
      FOREIGN KEY ("frameID") REFERENCES "AvatarFrameAsset"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'UserAvatarFrameGrant_operatorUserID_fkey'
      AND conrelid = '"UserAvatarFrameGrant"'::regclass
  ) THEN
    ALTER TABLE "UserAvatarFrameGrant"
      ADD CONSTRAINT "UserAvatarFrameGrant_operatorUserID_fkey"
      FOREIGN KEY ("operatorUserID") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'UserAvatarFrameGrant_revokedByUserID_fkey'
      AND conrelid = '"UserAvatarFrameGrant"'::regclass
  ) THEN
    ALTER TABLE "UserAvatarFrameGrant"
      ADD CONSTRAINT "UserAvatarFrameGrant_revokedByUserID_fkey"
      FOREIGN KEY ("revokedByUserID") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;

INSERT INTO "AvatarFrameAsset" (
  "id",
  "key",
  "name",
  "description",
  "minimumVipLevel",
  "sortOrder",
  "updatedAt"
)
VALUES
  (
    '00000000-0000-4000-8000-000000000003',
    'membership-diamond',
    'Diamond Avatar Frame',
    'Unlocked by an active Diamond or Super membership.',
    3,
    30,
    CURRENT_TIMESTAMP
  ),
  (
    '00000000-0000-4000-8000-000000000004',
    'membership-super',
    'Super Avatar Frame',
    'Unlocked by a Super membership.',
    4,
    40,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("key") DO NOTHING;

-- Install the foreign key without a table scan while holding the brief ALTER
-- lock. New writes are enforced immediately; historical rows are validated
-- after the bounded backfill completes.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'User_selectedAvatarFrameID_fkey'
      AND conrelid = '"User"'::regclass
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_selectedAvatarFrameID_fkey"
      FOREIGN KEY ("selectedAvatarFrameID") REFERENCES "AvatarFrameAsset"("id")
      ON DELETE SET NULL ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;

COMMIT;

-- Preserve the appearance of currently eligible legacy members. Super is a
-- lifetime tier even if historical data still carries a stale vipExpiresAt;
-- Diamond is effective only while its nullable expiry remains current.
UPDATE "User" AS u
SET
  "selectedAvatarFrameID" = frame."id",
  "selectedAvatarFrameExpiresAt" = CASE
    WHEN u."vipLevel" >= 4 THEN NULL
    ELSE u."vipExpiresAt"
  END
FROM "AvatarFrameAsset" AS frame
WHERE frame."key" = CASE
    WHEN u."vipLevel" >= 4 THEN 'membership-super'
    ELSE 'membership-diamond'
  END
  AND (
    u."vipLevel" >= 4
    OR (
      u."vipLevel" = 3
      AND (
        u."vipExpiresAt" IS NULL
        OR u."vipExpiresAt" > CURRENT_TIMESTAMP
      )
    )
  );

ALTER TABLE "User"
  VALIDATE CONSTRAINT "User_selectedAvatarFrameID_fkey";

RESET lock_timeout;
