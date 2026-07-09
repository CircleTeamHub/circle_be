-- Per-friend private annotations (description + description photos) and a
-- moments-access permission tier, staged on the request and promoted on accept.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FriendPermission') THEN
    CREATE TYPE "FriendPermission" AS ENUM ('FULL', 'CHAT_ONLY');
  END IF;
END $$;

ALTER TABLE "Friend"
  ADD COLUMN IF NOT EXISTS "pendingDescriptionBySender" TEXT,
  ADD COLUMN IF NOT EXISTS "descriptionA" TEXT,
  ADD COLUMN IF NOT EXISTS "descriptionB" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingPhotosBySender" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "photosA" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "photosB" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "pendingPermissionBySender" "FriendPermission",
  ADD COLUMN IF NOT EXISTS "permissionA" "FriendPermission" NOT NULL DEFAULT 'FULL',
  ADD COLUMN IF NOT EXISTS "permissionB" "FriendPermission" NOT NULL DEFAULT 'FULL';
