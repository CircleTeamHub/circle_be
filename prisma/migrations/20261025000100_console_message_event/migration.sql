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
--
-- 例外:漏斗最后一步要「入圈之后」的 MESSAGE_SENT。同一桶里先发消息、再入圈、再发
-- 消息时,桶首条早于入圈,入圈后那条若也被合并掉,走完漏斗的人就被算漏。所以桶已有
-- 记录时,再看桶首条之后有没有这个用户的 GROUP_JOINED:有就补记一条入圈后的消息
-- (每桶最多一条)。只在冲突路径上走,查的是 (userID, createdAt) 索引上这个用户最近
-- 几分钟的事件。
CREATE OR REPLACE FUNCTION circle_console_message_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bucket bigint := floor(extract(epoch FROM NEW."createdAt") / 300)::bigint;
  first_at "ConsoleEvent"."createdAt"%TYPE;
BEGIN
  INSERT INTO "ConsoleEvent" (id,"userID",name,"entityType","entityID","createdAt")
  SELECT encode(sha256(convert_to('MESSAGE_SENT:' || NEW."senderID" || ':' || bucket, 'UTF8')), 'hex'),
         NEW."senderID", 'MESSAGE_SENT', 'ChatMessage', NEW.id, NEW."createdAt"
  WHERE EXISTS (SELECT 1 FROM "User" WHERE id = NEW."senderID")
  ON CONFLICT (id) DO NOTHING;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  SELECT "createdAt" INTO first_at FROM "ConsoleEvent"
  WHERE id = encode(sha256(convert_to('MESSAGE_SENT:' || NEW."senderID" || ':' || bucket, 'UTF8')), 'hex');
  IF first_at IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO "ConsoleEvent" (id,"userID",name,"entityType","entityID","createdAt")
  SELECT encode(sha256(convert_to('MESSAGE_SENT:after-join:' || NEW."senderID" || ':' || bucket, 'UTF8')), 'hex'),
         NEW."senderID", 'MESSAGE_SENT', 'ChatMessage', NEW.id, NEW."createdAt"
  WHERE EXISTS (
    SELECT 1 FROM "ConsoleEvent" j
    WHERE j."userID" = NEW."senderID" AND j.name = 'GROUP_JOINED'
      AND j."createdAt" > first_at AND j."createdAt" <= NEW."createdAt"
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER console_message AFTER INSERT ON "ChatMessage" FOR EACH ROW WHEN (NEW."senderID" IS NOT NULL) EXECUTE FUNCTION circle_console_message_event();

RESET lock_timeout;
