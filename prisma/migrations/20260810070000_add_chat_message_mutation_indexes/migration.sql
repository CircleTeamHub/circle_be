-- 重连追平（GET /chat/messages/mutations）按变更时刻扫描。
-- 没有这两条索引的话，高频群里每次重连都要扫该会话的整段历史，
-- 只为捞出最近几条撤回/编辑。
CREATE INDEX "ChatMessage_conversationID_revokedAt_idx" ON "ChatMessage"("conversationID", "revokedAt");
CREATE INDEX "ChatMessage_conversationID_editedAt_idx" ON "ChatMessage"("conversationID", "editedAt");
