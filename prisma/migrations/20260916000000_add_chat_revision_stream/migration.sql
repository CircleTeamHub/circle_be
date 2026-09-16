-- 会话变更序号流（取代按时间戳扫的 GET /chat/messages/mutations）。
--
-- 原来新消息按 height 同步，撤回/编辑/焚毁另走一条按 revokedAt/editedAt/deletedAt
-- 时间戳扫的增量通道。那条通道要靠复合游标、60 秒安全水位和 14 天回溯窗口才勉强
-- 正确（时间戳在语句构造时生成、行到提交才可见，早时间戳可能晚提交），而表情回应、
-- 焚毁到期之外的离线变更根本没有入口。
--
-- 现在每次客户端可见的变更都在会话计数器 nextRevision 上取一个新号，写进
-- ChatMessage.revision。计数器更新拿的是会话行锁、持有到提交：任何读者读到
-- nextRevision = N 时，<= N 的变更都已提交。客户端只需一个 afterRevision 游标。
--
-- 取号放在触发器里而不是逐个改应用代码：发消息、服务端消息、系统消息、自动回复、
-- 撤回、编辑、焚毁清扫、放宽焚毁，加上 30 多处系统/服务端消息的调用方，漏掉任何
-- 一处都是一类变更永远同步不到；蓝绿发布窗口里旧版本实例的写入也一样被覆盖。

ALTER TABLE "ChatConversation" ADD COLUMN "nextRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatMessage" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- 存量：每条消息的当前状态就是它的最新版本，序号沿用 height（同会话内唯一、递增）。
-- 已撤回/已编辑/已焚毁的历史行也一样 —— 同步返回的是当前状态，不是变更日志。
UPDATE "ChatMessage" SET "revision" = "height";
UPDATE "ChatConversation" c
SET "nextRevision" = GREATEST(
  c."nextHeight",
  COALESCE((SELECT MAX(m."revision") FROM "ChatMessage" m WHERE m."conversationID" = c."id"), 0)
);

CREATE INDEX "ChatMessage_conversationID_revision_idx"
ON "ChatMessage"("conversationID", "revision");

-- 旧增量通道专用的三条索引随通道一起退役（列保留：deletedAt 仍是焚毁时刻的留痕）。
DROP INDEX IF EXISTS "ChatMessage_conversationID_revokedAt_idx";
DROP INDEX IF EXISTS "ChatMessage_conversationID_editedAt_idx";
DROP INDEX IF EXISTS "ChatMessage_conversationID_deletedAt_idx";

CREATE OR REPLACE FUNCTION chat_message_assign_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocated integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."conversationID" IS DISTINCT FROM OLD."conversationID"
       OR NEW."height" IS DISTINCT FROM OLD."height" THEN
      RAISE EXCEPTION 'ChatMessage identity and height are immutable';
    END IF;
    IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS NULL THEN
      RAISE EXCEPTION 'A revoked ChatMessage cannot be restored';
    END IF;
    IF OLD."deleted" AND NOT NEW."deleted" THEN
      RAISE EXCEPTION 'A burned ChatMessage cannot be restored';
    END IF;
    -- 表情回应触发器已经显式换好了序号：照用，不再取第二个号。
    IF NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      RETURN NEW;
    END IF;
    -- 客户端看不见的列（如 contentHistory 单独变动）不占号。
    IF (NEW."content", NEW."deleted", NEW."revokedAt", NEW."editedAt")
       IS NOT DISTINCT FROM
       (OLD."content", OLD."deleted", OLD."revokedAt", OLD."editedAt") THEN
      RETURN NEW;
    END IF;
  END IF;

  UPDATE "ChatConversation"
  SET "nextRevision" = "nextRevision" + 1
  WHERE "id" = NEW."conversationID"
  RETURNING "nextRevision" INTO allocated;
  IF allocated IS NULL THEN
    RAISE EXCEPTION 'ChatConversation % does not exist', NEW."conversationID";
  END IF;
  NEW."revision" := allocated;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_message_assign_revision ON "ChatMessage";
CREATE TRIGGER chat_message_assign_revision
BEFORE INSERT OR UPDATE ON "ChatMessage"
FOR EACH ROW EXECUTE FUNCTION chat_message_assign_revision();

-- 表情回应在子表里，消息行本身不变：给所属消息取一个新号，同步时整条消息
-- （带完整回应列表）重新下发。
CREATE OR REPLACE FUNCTION chat_message_reaction_bump_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_message text;
  target_conversation text;
  allocated integer;
BEGIN
  target_message := CASE WHEN TG_OP = 'DELETE' THEN OLD."messageID" ELSE NEW."messageID" END;
  SELECT "conversationID" INTO target_conversation
  FROM "ChatMessage" WHERE "id" = target_message;
  -- 消息本身正被级联删除：没有可同步的对象。
  IF target_conversation IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE "ChatConversation"
  SET "nextRevision" = "nextRevision" + 1
  WHERE "id" = target_conversation
  RETURNING "nextRevision" INTO allocated;
  UPDATE "ChatMessage" SET "revision" = allocated WHERE "id" = target_message;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS chat_message_reaction_bump_revision ON "ChatMessageReaction";
CREATE TRIGGER chat_message_reaction_bump_revision
AFTER INSERT OR DELETE ON "ChatMessageReaction"
FOR EACH ROW EXECUTE FUNCTION chat_message_reaction_bump_revision();
