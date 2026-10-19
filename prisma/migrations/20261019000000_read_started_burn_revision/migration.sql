-- Keep expiry updates visible to offline and reconnecting devices.
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
    IF (NEW."content", NEW."deleted", NEW."revokedAt", NEW."editedAt", NEW."burnExpiresAt")
       IS NOT DISTINCT FROM
       (OLD."content", OLD."deleted", OLD."revokedAt", OLD."editedAt", OLD."burnExpiresAt") THEN
      RETURN NEW;
    END IF;
  END IF;

  -- GREATEST 带上 nextHeight：存量消息回填成 revision = height，会话计数器没有整表
  -- 初始化，从没变过的会话 nextRevision 还是 0。自动回复/系统消息是先插消息、后推
  -- nextHeight，插入这一刻 nextHeight 可能比新行的 height 小 1 —— 分到的号仍然大于
  -- 所有已提交消息的 height 与 revision，不会撞号。
  UPDATE "ChatConversation"
  SET "nextRevision" = GREATEST("nextRevision", "nextHeight") + 1
  WHERE "id" = NEW."conversationID"
  RETURNING "nextRevision" INTO allocated;
  IF allocated IS NULL THEN
    RAISE EXCEPTION 'ChatConversation % does not exist', NEW."conversationID";
  END IF;
  NEW."revision" := allocated;
  RETURN NEW;
END;
$$;
