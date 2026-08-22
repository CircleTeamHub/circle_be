-- Store only a coarse browser/OS label for the phone confirmation screen.
-- Existing two-minute sessions get a neutral value and remain valid.
ALTER TABLE "QrLoginSession"
ADD COLUMN "requestDevice" TEXT NOT NULL DEFAULT 'Unknown browser · Unknown OS';
