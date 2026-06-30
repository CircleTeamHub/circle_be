-- Add canonical first-release system badge keys used by the mobile client.
-- PARTNER remains as a legacy enum value for databases that already applied
-- 20260628000008_partner_enum_and_like_index; the service no longer emits it.
ALTER TYPE "SystemIconKey" ADD VALUE IF NOT EXISTS 'TOP_COLLABORATOR';
ALTER TYPE "SystemIconKey" ADD VALUE IF NOT EXISTS 'VERIFIED_PROFILE';
ALTER TYPE "SystemIconKey" ADD VALUE IF NOT EXISTS 'CIRCLE_BUILDER';
