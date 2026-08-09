-- OpenIM 拆栈:三张同步 outbox 表与 User.openimSynced 标记随之删除。
DROP TABLE IF EXISTS "UserProfileSyncOutbox";
DROP TABLE IF EXISTS "GroupSyncOutbox";
DROP TABLE IF EXISTS "FriendSyncOutbox";
DROP TYPE IF EXISTS "UserProfileSyncStatus";
DROP TYPE IF EXISTS "GroupSyncOperation";
DROP TYPE IF EXISTS "GroupSyncStatus";
DROP TYPE IF EXISTS "FriendSyncOperation";
DROP TYPE IF EXISTS "FriendSyncStatus";
ALTER TABLE "User" DROP COLUMN IF EXISTS "openimSynced";
