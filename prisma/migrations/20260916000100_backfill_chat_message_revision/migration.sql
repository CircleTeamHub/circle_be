-- 存量消息的 revision 回填（过程定义在 20260916000000_add_chat_revision_stream）。
--
-- 本文件不能出现美元符号引用：prisma migrate deploy 对含它的文件整份包进一个隐式事务，
-- 过程里的 COMMIT 就会报 invalid transaction termination。不含时逐条语句自动提交，
-- CALL 在自己的事务里执行，过程可以每批提交 —— 每批只锁 5000 行、很快放掉，
-- 旧色这段时间对存量消息的撤回/编辑最多等一批。
--
-- 每条存量消息的当前状态就是它的最新版本，序号沿用 height（同会话内唯一、递增）。
-- 已撤回/已编辑/已焚毁的历史行也一样 —— 同步返回的是当前状态，不是变更日志。
-- 可重跑：只填仍为 0 的行。
CALL chat_message_backfill_revision(5000);
DROP PROCEDURE IF EXISTS chat_message_backfill_revision(integer);
