-- The old schema cannot distinguish system-accepted invitations from an
-- invitee's own acceptance. Conservatively reserve every actionable pending
-- invitation during rollout; review, rejection or expiry releases it.
UPDATE "GroupAdmission"
SET "consentSeatReserved" = true
WHERE "kind" = 'INVITE'
  AND "status" = 'PENDING'
  AND "acceptedAt" IS NOT NULL;
