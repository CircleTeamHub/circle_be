-- 陌生设备登录的「找回」：账号下的受信任设备全都用不了（唯一的手机重装、丢失、恢复
-- 出厂）时，新设备可以申请等待期后自动登录。申请时间与可完成时间记在验证单上。
--
-- 过期验证单的清理改为按 expiresAt（找回申请的有效期会延长到等待期之后），
-- 所以给 expiresAt 加索引。LoginChallenge 是冷表，普通建索引即可。
--
-- 可逆：DROP COLUMN / DROP INDEX 即可回滚，旧二进制不读这两列。无需抬 SCHEMA_COMPATIBILITY。
ALTER TABLE "LoginChallenge"
  ADD COLUMN "recoveryRequestedAt" TIMESTAMP(3),
  ADD COLUMN "recoveryAvailableAt" TIMESTAMP(3);

CREATE INDEX "LoginChallenge_expiresAt_idx" ON "LoginChallenge"("expiresAt");
