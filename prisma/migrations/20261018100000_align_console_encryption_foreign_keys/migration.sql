-- Align hand-written foreign keys with Prisma default ON UPDATE CASCADE.
-- Preserve existing delete behavior and leave already-applied migrations unchanged.
BEGIN;
ALTER TABLE "ConsoleEvent" DROP CONSTRAINT "ConsoleEvent_userID_fkey";
ALTER TABLE "ConsoleEvent" ADD CONSTRAINT "ConsoleEvent_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppInstallation" DROP CONSTRAINT "AppInstallation_userID_fkey";
ALTER TABLE "AppInstallation" ADD CONSTRAINT "AppInstallation_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsoleApiKey" DROP CONSTRAINT "ConsoleApiKey_userID_fkey";
ALTER TABLE "ConsoleApiKey" ADD CONSTRAINT "ConsoleApiKey_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsoleReleasePlan" DROP CONSTRAINT "ConsoleReleasePlan_releaseID_fkey";
ALTER TABLE "ConsoleReleasePlan" ADD CONSTRAINT "ConsoleReleasePlan_releaseID_fkey" FOREIGN KEY ("releaseID") REFERENCES "ConsoleRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "E2eeArchive" DROP CONSTRAINT "E2eeArchive_recoveryID_fkey";
ALTER TABLE "E2eeArchive" ADD CONSTRAINT "E2eeArchive_recoveryID_fkey" FOREIGN KEY ("recoveryID") REFERENCES "E2eeRecovery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "E2eeArchive" DROP CONSTRAINT "E2eeArchive_messageID_fkey";
ALTER TABLE "E2eeArchive" ADD CONSTRAINT "E2eeArchive_messageID_fkey" FOREIGN KEY ("messageID") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
