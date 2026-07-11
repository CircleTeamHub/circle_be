-- Repair legacy pending memberships before enforcing one pending application
-- per applicant/circle. IDs are text UUIDs in the legacy schema and are created
-- here without relying on a database UUID extension.
INSERT INTO "CircleInvitation" (
  "id",
  "circleID",
  "applicantID",
  "inviterID",
  "requiredCount",
  "approvedCount",
  "status",
  "createdAt",
  "updatedAt"
)
SELECT
  substr(md5(random()::text || clock_timestamp()::text), 1, 8) || '-' ||
  substr(md5(random()::text || clock_timestamp()::text), 9, 4) || '-4' ||
  substr(md5(random()::text || clock_timestamp()::text), 14, 3) || '-a' ||
  substr(md5(random()::text || clock_timestamp()::text), 18, 3) || '-' ||
  substr(md5(random()::text || clock_timestamp()::text), 21, 12),
  member."circleID",
  member."userID",
  member."userID",
  10,
  0,
  'PENDING',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "CircleMember" AS member
WHERE member."status" = 'PENDING'
  AND NOT EXISTS (
    SELECT 1
    FROM "CircleInvitation" AS invitation
    WHERE invitation."circleID" = member."circleID"
      AND invitation."applicantID" = member."userID"
      AND invitation."status" = 'PENDING'
  );

DO $$
DECLARE
  pair RECORD;
  canonical_id TEXT;
  max_required INTEGER;
  verifier RECORD;
BEGIN
  FOR pair IN
    SELECT "circleID", "applicantID"
    FROM "CircleInvitation"
    WHERE "status" = 'PENDING'
    GROUP BY "circleID", "applicantID"
    HAVING COUNT(*) > 1
  LOOP
    SELECT invitation."id"
    INTO canonical_id
    FROM "CircleInvitation" AS invitation
    WHERE invitation."circleID" = pair."circleID"
      AND invitation."applicantID" = pair."applicantID"
      AND invitation."status" = 'PENDING'
    ORDER BY invitation."createdAt", invitation."id"
    LIMIT 1;

    SELECT MAX(invitation."requiredCount")
    INTO max_required
    FROM "CircleInvitation" AS invitation
    WHERE invitation."circleID" = pair."circleID"
      AND invitation."applicantID" = pair."applicantID"
      AND invitation."status" = 'PENDING';

    UPDATE "CircleInvitation"
    SET "requiredCount" = max_required
    WHERE "id" = canonical_id;

    FOR verifier IN
      SELECT source."verifierID",
             source."addedByID",
             source."status",
             source."respondedAt",
             source."createdAt"
      FROM "CircleInvitationVerifier" AS source
      JOIN "CircleInvitation" AS source_invitation
        ON source_invitation."id" = source."invitationID"
      WHERE source_invitation."circleID" = pair."circleID"
        AND source_invitation."applicantID" = pair."applicantID"
        AND source_invitation."status" = 'PENDING'
        AND source."invitationID" <> canonical_id
      ORDER BY source."verifierID",
        CASE source."status"
          WHEN 'APPROVED' THEN 0
          WHEN 'PENDING' THEN 1
          ELSE 2
        END,
        source."createdAt"
    LOOP
      INSERT INTO "CircleInvitationVerifier" (
        "id", "invitationID", "verifierID", "addedByID", "status",
        "respondedAt", "createdAt"
      ) VALUES (
        substr(md5(random()::text || clock_timestamp()::text), 1, 8) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 9, 4) || '-4' ||
        substr(md5(random()::text || clock_timestamp()::text), 14, 3) || '-a' ||
        substr(md5(random()::text || clock_timestamp()::text), 18, 3) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 21, 12),
        canonical_id,
        verifier."verifierID",
        verifier."addedByID",
        verifier."status",
        verifier."respondedAt",
        verifier."createdAt"
      )
      ON CONFLICT ("invitationID", "verifierID") DO UPDATE
      SET "status" = CASE
            WHEN "CircleInvitationVerifier"."status" = 'APPROVED'
              OR EXCLUDED."status" = 'APPROVED' THEN 'APPROVED'
            WHEN "CircleInvitationVerifier"."status" = 'PENDING'
              OR EXCLUDED."status" = 'PENDING' THEN 'PENDING'
            ELSE 'REJECTED'
          END,
          "respondedAt" = COALESCE(
            "CircleInvitationVerifier"."respondedAt",
            EXCLUDED."respondedAt"
          );
    END LOOP;

    UPDATE "CircleInvitation"
    SET "approvedCount" = (
      SELECT COUNT(*)
      FROM "CircleInvitationVerifier" AS verifier
      WHERE verifier."invitationID" = canonical_id
        AND verifier."status" = 'APPROVED'
    )
    WHERE "id" = canonical_id;

    UPDATE "CircleInvitation"
    SET "status" = 'CANCELLED'
    WHERE "circleID" = pair."circleID"
      AND "applicantID" = pair."applicantID"
      AND "status" = 'PENDING'
      AND "id" <> canonical_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "CircleInvitation_pending_circleID_applicantID_key"
  ON "CircleInvitation" ("circleID", "applicantID")
  WHERE "status" = 'PENDING';
