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

-- 发布方式（蓝绿，旧色在迁移期间照常服务）：拆成三个迁移。
-- prisma migrate deploy 对含 $$ 的迁移文件整份放进一个隐式事务执行（实测：同文件里的
-- CREATE INDEX CONCURRENTLY 报 cannot run inside a transaction block、DO 块里 COMMIT 报
-- invalid transaction termination，出错时前面的语句一起回滚）；不含 $$ 的文件逐条语句
-- 自动提交。所以本文件只放瞬时 DDL（加列、函数、触发器，持锁到文件结束也只有毫秒级），
-- 存量回填与建索引放到后面两个不含 $$ 的迁移里分批做：
--   20260916000100_backfill_chat_message_revision  分批回填，每批独立提交
--   20260916000200_add_chat_message_revision_index CREATE INDEX CONCURRENTLY
-- 原来一个文件里加列 + 全表 UPDATE + 普通建索引，整段持有 ChatMessage/ChatConversation
-- 的排他锁，迁移多久聊天就停多久（连读都停）。
--
-- 触发器先于回填生效：取号用 GREATEST(nextRevision, nextHeight) + 1。存量消息回填成
-- revision = height，而 height 从不超过会话的 nextHeight —— 新分配的号永远大于任何
-- 存量号，回填跑完之前、之中、之后的写入都不会撞号，也不必为了初始化计数器整表
-- 更新会话行（那会在更新期间挡住所有会话的发消息）。读侧的水位同样取
-- max(nextRevision, nextHeight)，见 conversationSyncRevision。
--
-- 旧增量通道的三条索引（revokedAt/editedAt/deletedAt）这一版不删：回滚目标（旧二进制）
-- 还在用 GET /chat/messages/mutations。按 expand/contract 留到后续版本删除。
--
-- 触发器对旧二进制兼容：旧代码从不改 id/conversationID/height，也不恢复撤回或焚毁
-- （revokedAt: null / deleted: false 只出现在 where 条件里），下面的不变量检查不会
-- 让旧色的写入报错；旧色写入的消息同样由触发器取号。

ALTER TABLE "ChatConversation" ADD COLUMN IF NOT EXISTS "nextRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0;

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
  SET "nextRevision" = GREATEST("nextRevision", "nextHeight") + 1
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

-- 存量回填用的过程：按主键分批，每批独立提交（下一个迁移 CALL 完即删）。
-- 只填 revision = 0 的行：触发器生效之后被撤回/编辑/加了回应的存量消息已经分到了
-- 新号，不能被回填盖回 height。
CREATE OR REPLACE PROCEDURE chat_message_backfill_revision(batch_size integer)
LANGUAGE plpgsql AS $$
DECLARE
  last_id text := '';
  batch_last text;
BEGIN
  LOOP
    SELECT max(b."id") INTO batch_last
    FROM (
      SELECT "id" FROM "ChatMessage"
      WHERE "id" > last_id
      ORDER BY "id"
      LIMIT batch_size
    ) b;
    EXIT WHEN batch_last IS NULL;
    UPDATE "ChatMessage"
    SET "revision" = "height"
    WHERE "id" > last_id AND "id" <= batch_last AND "revision" = 0;
    last_id := batch_last;
    COMMIT;
  END LOOP;
END;
$$;
