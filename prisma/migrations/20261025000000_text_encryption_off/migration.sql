-- 文字加密停用(第一阶段):已经开了加密的会话改回明文模式。
--
-- 只动数据,不动结构:E2ee* 七张表、src/e2ee 模块和 textEncryption 列都留到第二阶段,
-- 等确认没有真实用户依赖加密数据之后再删。旧二进制照样能跑在这份数据上
-- (它们本来就接受 PLAIN 会话),所以不抬 deploy/SCHEMA_COMPATIBILITY。
--
-- 可撤回:开加密(createRoom)与写 E2eeRoom 在同一个事务里,E2eeRoom 一行对应一个
-- 曾经改成 MLS_V1 的会话。要恢复原状,回滚代码后执行:
--   UPDATE "ChatConversation" c SET "textEncryption" = 'MLS_V1' FROM "E2eeRoom" r WHERE r."conversationID" = c."id";
UPDATE "ChatConversation"
SET "textEncryption" = 'PLAIN'
WHERE "textEncryption" = 'MLS_V1';
