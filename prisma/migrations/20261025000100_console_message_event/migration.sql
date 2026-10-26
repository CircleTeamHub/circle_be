-- 运营台事件量收口(一):聊天消息是全站最热的写入路径,旧触发器(通用
-- circle_console_event)每条消息写一条 ConsoleEvent,还把整行(含消息密文)转成
-- jsonb 两次,并且就在发送事务、会话行锁持有期间执行。改为每人每 5 分钟一条
-- (与 APP_OPEN 同口径)。会话事件见 20261025000150_console_session_event;
-- 其余触发器不动。
-- 换触发器要拿表锁,等不到 5 秒就失败重来,别把写入堵在锁队列里。失败时整份回滚,
-- _prisma_migrations 留下一条失败记录:先 `npx prisma migrate resolve --rolled-back 20261025000100_console_message_event`,
-- 再重跑 migrate deploy。
-- 一份迁移只换一张表的触发器:含函数体的文件整份一个事务,两张表写在一起就会
-- 占着前一张表的锁去等后一张,最坏停写时间翻倍。
SET lock_timeout = '5s';

-- 只读 senderID/id/createdAt。桶内第一条消息胜出(时间和 id 都保留,漏斗的 MIN 不变),
-- 同桶后续消息 ON CONFLICT 跳过;并发的同桶第二条会在主键上等第一条事务结束,
-- 第一条回滚时由它补上。id 取桶键的 sha256:运营台分页游标只认 uuid 或 64 位 hex。
-- senderID 没有外键(临时会话访客等不在 User 里),EXISTS 不能省。
CREATE OR REPLACE FUNCTION circle_console_message_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ConsoleEvent" (id,"userID",name,"entityType","entityID","createdAt")
  SELECT encode(sha256(convert_to('MESSAGE_SENT:' || NEW."senderID" || ':' || floor(extract(epoch FROM NEW."createdAt") / 300)::bigint, 'UTF8')), 'hex'),
         NEW."senderID", 'MESSAGE_SENT', 'ChatMessage', NEW.id, NEW."createdAt"
  WHERE EXISTS (SELECT 1 FROM "User" WHERE id = NEW."senderID")
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER console_message AFTER INSERT ON "ChatMessage" FOR EACH ROW WHEN (NEW."senderID" IS NOT NULL) EXECUTE FUNCTION circle_console_message_event();

RESET lock_timeout;
