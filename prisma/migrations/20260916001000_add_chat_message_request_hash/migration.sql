-- 客户端发送请求的指纹。幂等键 d 撞库时,原来一律把库里那条当成同一条消息的重发
-- 原样返回;同一个 d 带着另一份内容过来时,发送方显示「发送成功」,收件人收到的却是
-- 旧内容。现在指纹不同就拒收(CHAT_DELIVERY_ID_CONFLICT)。
-- 可空、不回填:历史行没有指纹可比,保持原来的「原样返回」。
ALTER TABLE "ChatMessage" ADD COLUMN "requestHash" VARCHAR(64);
