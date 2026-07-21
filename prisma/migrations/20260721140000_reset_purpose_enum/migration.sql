-- FE#92: password-reset email codes. Enum ADD VALUE must be its own migration
-- (usable only by statements in later transactions).
ALTER TYPE "EmailCodePurpose" ADD VALUE 'RESET_PASSWORD';
