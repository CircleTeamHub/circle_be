-- 运营台事件量收口(二):refresh token 每次续签都会 INSERT 一行,旧触发器把每次
-- 续签都记成 SESSION_CREATED(语义也不对),同样 to_jsonb 整行两次。改为只记新登录。
-- 消息事件见 20261025000100_console_message_event。
-- 换触发器要拿表锁,等不到 5 秒就失败重来,别把写入堵在锁队列里。失败时整份回滚,
-- _prisma_migrations 留下一条失败记录:先 `npx prisma migrate resolve --rolled-back 20261025000150_console_session_event`,
-- 再重跑 migrate deploy。
-- 一份迁移只换一张表的触发器:含函数体的文件整份一个事务,两张表写在一起就会
-- 占着前一张表的锁去等后一张,最坏停写时间翻倍。
SET lock_timeout = '5s';

-- 续签(RefreshTokenService.rotate)新行沿用旧行的 familyId,新登录才生成新 family,
-- 所以「本 family 里没有别的行」= 新登录。走 (userId, familyId) 索引;AFTER 触发器
-- 看得见本行,要排除自己。userId 有外键,不用再查 User。
CREATE OR REPLACE FUNCTION circle_console_session_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RefreshToken" r WHERE r."userId" = NEW."userId" AND r."familyId" = NEW."familyId" AND r.id <> NEW.id) THEN
    INSERT INTO "ConsoleEvent" (id,"userID",name,"entityType","entityID") VALUES (gen_random_uuid()::text, NEW."userId", 'SESSION_CREATED', 'RefreshToken', NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER console_session AFTER INSERT ON "RefreshToken" FOR EACH ROW EXECUTE FUNCTION circle_console_session_event();

RESET lock_timeout;
