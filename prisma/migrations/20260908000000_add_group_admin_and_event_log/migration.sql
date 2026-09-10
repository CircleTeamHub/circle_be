-- 群管理 + 群日志(docs 见 circle-im/docs/superpowers/specs/2026-09-08-group-admin-and-log-design.md)。
--
-- 纯 expand:新枚举、带默认值的新列、新表。蓝绿窗口里旧二进制照常读写 ChatMember
-- (它不认识的列有默认值,不参与它的 select/insert),不抬 SCHEMA_COMPATIBILITY。

-- 1) 独立群聊的管理员角色。群主仍看 ChatConversation.ownerID(退群转让只改那一处)。
CREATE TYPE "ChatMemberRole" AS ENUM ('MEMBER', 'ADMIN');

ALTER TABLE "ChatMember"
  ADD COLUMN IF NOT EXISTS "role" "ChatMemberRole" NOT NULL DEFAULT 'MEMBER',
  -- 禁言(不能发言)。与 muted(免打扰)无关:silencedAt 非空 = 禁言中,
  -- silencedUntil 空 = 直到解除。
  ADD COLUMN IF NOT EXISTS "silencedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "silencedUntil" TIMESTAMP(3);

-- 2) 群事件账本。不从历史 system 消息回填:测试服没有需要保留的真实记录,
--    回填还会把 member-joined 那种只有昵称没有 userID 的老载荷带进新表。
CREATE TABLE "ChatGroupEvent" (
  "id"             TEXT NOT NULL,
  "conversationID" TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "actorID"        TEXT,
  "targetIDs"      TEXT[] DEFAULT ARRAY[]::TEXT[],
  "payload"        JSONB,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatGroupEvent_pkey" PRIMARY KEY ("id")
);

-- 群日志按会话倒序 keyset 分页:(createdAt, id) 复合游标,索引顺序与排序一致。
CREATE INDEX "ChatGroupEvent_conversationID_createdAt_id_idx"
  ON "ChatGroupEvent"("conversationID", "createdAt", "id");

ALTER TABLE "ChatGroupEvent"
  ADD CONSTRAINT "ChatGroupEvent_conversationID_fkey"
  FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
