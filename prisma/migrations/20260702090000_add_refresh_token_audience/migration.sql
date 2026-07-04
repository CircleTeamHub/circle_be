DO $$ BEGIN
  CREATE TYPE "RefreshTokenAudience" AS ENUM ('APP', 'ADMIN');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "RefreshToken"
ADD COLUMN IF NOT EXISTS "audience" "RefreshTokenAudience" NOT NULL DEFAULT 'APP';
