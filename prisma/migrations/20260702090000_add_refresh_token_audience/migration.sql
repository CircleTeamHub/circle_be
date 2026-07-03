CREATE TYPE "RefreshTokenAudience" AS ENUM ('APP', 'ADMIN');

ALTER TABLE "RefreshToken"
ADD COLUMN "audience" "RefreshTokenAudience" NOT NULL DEFAULT 'APP';
