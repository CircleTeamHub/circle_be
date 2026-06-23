-- Strip the legacy ACC_ prefix AND normalize to lowercase. accountId is now a
-- user-editable handle whose uniqueness is treated case-insensitively (see
-- AuthService.changeAccountId / UserService.findByExactAccountId), so all stored
-- ids must be canonical lowercase to keep the unique constraint meaningful.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User" prefixed
    JOIN "User" other
      ON lower(substring(prefixed."accountId" FROM 5)) = lower(other."accountId")
     AND other.id <> prefixed.id
    WHERE prefixed."accountId" ~ '^ACC_[A-Z0-9]{6}$'
  ) THEN
    RAISE EXCEPTION 'Cannot remove ACC_ accountId prefix because a stripped accountId already exists';
  END IF;
END $$;

UPDATE "User"
SET "accountId" = lower(substring("accountId" FROM 5))
WHERE "accountId" ~ '^ACC_[A-Z0-9]{6}$';
