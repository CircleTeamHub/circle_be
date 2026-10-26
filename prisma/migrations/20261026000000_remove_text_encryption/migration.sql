-- 文字加密下线(第二阶段):整个功能删除 —— src/e2ee 模块、E2ee* 七张表、
-- ChatConversation.textEncryption 列,以及挂在聊天表上的加密归档触发器。
-- 第一阶段(20261025000000_text_encryption_off)已经停收密文、把会话改回 PLAIN。
--
-- 没有真实数据:功能 2026-10-17/18 才落地,唯一的测试服 10-16 已下线,此后没有任何
-- 一次发布真正部署过,所以不加「表非空就中止」的数据闸门,直接删。
--
-- 不可逆:旧二进制的 Prisma 客户端会读写 "textEncryption" 列和 E2ee* 表,跑在这份
-- schema 上会直接报错。因此 deploy/SCHEMA_COMPATIBILITY 4 → 5,并在
-- deploy/REQUIRES_IRREVERSIBLE_MIGRATION 里登记本迁移(只能停机 + 不可逆确认发布)。
--
-- 有意保留(不属于加密):
--   - ChatBurnArchive 表与 archive_burned_chat_message 触发器(20261019000200):
--     普通阅后即焚的 180 天审计留存,管理台归档查询、焚毁扫描、媒体引用、存储盘点都在用。
--   - circle_console_event() 函数(20261017012000):会话 / 设备 / 钱包 / 订单 / 举报的
--     控制台时间线共用,这里只删挂在 E2eeDevice 上的两个触发器。
--
-- 触发器与函数不在 Prisma 模型里,migrate diff 生成不出来,必须手写:表删了而
-- ChatMessage / ChatMember / ChatConversation 上的触发器还在,之后每一次撤回、焚毁、
-- 清空都会因为找不到 "E2eeArchive" 而失败。
--
-- 整份一个事务:文件末尾的自检含 $$,Prisma 切不开,整份作为一条多语句查询在隐式事务里
-- 执行(见 docs/migration-baseline.md),中途失败整体回滚,不会留下删了一半的状态。
-- 这里全是瞬时 DDL,ChatMessage / ChatMember / ChatConversation 的排他锁只持有毫秒级。

-- 1) 聊天表上的加密归档清理触发器(20261017002000)及其函数(20261019000200 改写过)。
DROP TRIGGER e2ee_message_retention ON "ChatMessage";
DROP TRIGGER e2ee_member_retention ON "ChatMember";
DROP TRIGGER e2ee_conversation_retention ON "ChatConversation";
DROP FUNCTION purge_e2ee_message_archive();
DROP FUNCTION purge_e2ee_cleared_archive();

-- 2) 控制台时间线里加密设备批准 / 撤销的触发器(20261017012000)。DROP TABLE
--    "E2eeDevice" 本来也会带走它们,写明是为了表明共用的 circle_console_event() 不动。
DROP TRIGGER console_encryption_approve ON "E2eeDevice";
DROP TRIGGER console_encryption_revoke ON "E2eeDevice";

-- 3) 以下由 prisma migrate diff(改动前 schema → 改动后 schema)生成。

-- DropForeignKey
ALTER TABLE "E2eeKeyPackage" DROP CONSTRAINT "E2eeKeyPackage_deviceID_fkey";

-- DropForeignKey
ALTER TABLE "E2eeRoom" DROP CONSTRAINT "E2eeRoom_conversationID_fkey";

-- DropForeignKey
ALTER TABLE "E2eeRoomDevice" DROP CONSTRAINT "E2eeRoomDevice_conversationID_fkey";

-- DropForeignKey
ALTER TABLE "E2eeRoomDevice" DROP CONSTRAINT "E2eeRoomDevice_deviceID_fkey";

-- DropForeignKey
ALTER TABLE "E2eeEpochEvent" DROP CONSTRAINT "E2eeEpochEvent_conversationID_fkey";

-- DropForeignKey
ALTER TABLE "E2eeRecovery" DROP CONSTRAINT "E2eeRecovery_userID_fkey";

-- DropForeignKey
ALTER TABLE "E2eeArchive" DROP CONSTRAINT "E2eeArchive_recoveryID_fkey";

-- DropForeignKey
ALTER TABLE "E2eeArchive" DROP CONSTRAINT "E2eeArchive_messageID_fkey";

-- AlterTable
ALTER TABLE "ChatConversation" DROP COLUMN "textEncryption";

-- DropTable
DROP TABLE "E2eeDevice";

-- DropTable
DROP TABLE "E2eeKeyPackage";

-- DropTable
DROP TABLE "E2eeRoom";

-- DropTable
DROP TABLE "E2eeRoomDevice";

-- DropTable
DROP TABLE "E2eeEpochEvent";

-- DropTable
DROP TABLE "E2eeRecovery";

-- DropTable
DROP TABLE "E2eeArchive";

-- 4) 收尾自检:当前 schema 里不能再有函数体引用 E2ee* 表。漏删的触发器函数平时不报错,
--    要等到下一次撤回 / 焚毁 / 清空才在运行时炸;在这里失败则整份迁移回滚。
DO $$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(p.proname::text, ', ' ORDER BY p.proname) INTO leftover
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = current_schema()
    AND p.prosrc LIKE '%"E2ee%';
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'functions still reference the dropped E2ee* tables: %', leftover;
  END IF;
END $$;
