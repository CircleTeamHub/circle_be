CREATE OR REPLACE FUNCTION circle_console_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT;
BEGIN
  actor := to_jsonb(NEW)->>TG_ARGV[0];
  IF actor IS NOT NULL AND EXISTS (SELECT 1 FROM "User" WHERE id=actor) THEN
    INSERT INTO "ConsoleEvent" (id,"userID",name,"entityType","entityID") VALUES (gen_random_uuid()::text,actor,TG_ARGV[1],TG_TABLE_NAME,to_jsonb(NEW)->>'id');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER console_session AFTER INSERT ON "RefreshToken" FOR EACH ROW EXECUTE FUNCTION circle_console_event('userId','SESSION_CREATED');
CREATE TRIGGER console_device_revoke AFTER UPDATE OF "revokedAt" ON "TrustedDevice" FOR EACH ROW WHEN (NEW."revokedAt" IS NOT NULL AND OLD."revokedAt" IS NULL) EXECUTE FUNCTION circle_console_event('userId','DEVICE_REVOKED');
CREATE TRIGGER console_encryption_approve AFTER UPDATE OF status ON "E2eeDevice" FOR EACH ROW WHEN (NEW.status='ACTIVE' AND OLD.status<>NEW.status) EXECUTE FUNCTION circle_console_event('userID','ENCRYPTION_DEVICE_APPROVED');
CREATE TRIGGER console_encryption_revoke AFTER UPDATE OF status ON "E2eeDevice" FOR EACH ROW WHEN (NEW.status='REVOKED' AND OLD.status<>NEW.status) EXECUTE FUNCTION circle_console_event('userID','ENCRYPTION_DEVICE_REVOKED');
CREATE TRIGGER console_wallet AFTER INSERT ON "CoinTransaction" FOR EACH ROW EXECUTE FUNCTION circle_console_event('userID','WALLET_ACTIVITY');
CREATE TRIGGER console_fancy_order AFTER INSERT ON "FancyNumberOrder" FOR EACH ROW EXECUTE FUNCTION circle_console_event('userID','ORDER_CREATED');
CREATE TRIGGER console_recharge_order AFTER INSERT ON "SupportRechargeOrder" FOR EACH ROW EXECUTE FUNCTION circle_console_event('userID','RECHARGE_ORDER_CREATED');
CREATE TRIGGER console_friend_report AFTER INSERT ON "FriendReport" FOR EACH ROW EXECUTE FUNCTION circle_console_event('reporterID','REPORT_CREATED');
CREATE TRIGGER console_group_report AFTER INSERT ON "GroupReport" FOR EACH ROW EXECUTE FUNCTION circle_console_event('reporterID','REPORT_CREATED');
CREATE TRIGGER console_post_report AFTER INSERT ON "CirclePostReport" FOR EACH ROW EXECUTE FUNCTION circle_console_event('reporterID','REPORT_CREATED');
CREATE FUNCTION circle_console_push_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient TEXT;
BEGIN
  SELECT "toUserID" INTO recipient FROM "Notification" WHERE id=NEW."notificationID";
  IF recipient IS NOT NULL AND EXISTS (SELECT 1 FROM "User" WHERE id=recipient) THEN
    INSERT INTO "ConsoleEvent" (id,"userID",name,"entityType","entityID") VALUES (gen_random_uuid()::text,recipient,CASE WHEN NEW.status='COMPLETED' THEN 'PUSH_COMPLETED' ELSE 'PUSH_TERMINATED' END,'NotificationPushOutbox',NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER console_push_event AFTER UPDATE OF status ON "NotificationPushOutbox" FOR EACH ROW WHEN (NEW.status IN ('COMPLETED','TERMINAL') AND OLD.status<>NEW.status) EXECUTE FUNCTION circle_console_push_event();
