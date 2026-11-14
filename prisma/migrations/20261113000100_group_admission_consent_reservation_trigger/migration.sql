CREATE OR REPLACE FUNCTION group_admission_reserve_consent_seat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The previous binary creates system-accepted review rows without knowing
  -- the new column. Cover that blue-green window without affecting a user's
  -- later INVITED -> PENDING acceptance, which is an UPDATE.
  IF NEW."kind" = 'INVITE'
    AND NEW."status" = 'PENDING'
    AND NEW."acceptedAt" IS NOT NULL THEN
    NEW."consentSeatReserved" := true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER group_admission_reserve_consent_seat
BEFORE INSERT ON "GroupAdmission"
FOR EACH ROW
EXECUTE FUNCTION group_admission_reserve_consent_seat();
