-- 资料页联系方式可见性补上邮箱这一档。
--
-- 在此之前 GET /user/:id 无条件返回 email：applyProfilePrivacy 只过 phoneNumber /
-- wechat / qq / whatsup，email 从 USER_PROFILE_SELECT 一路直出。没有造成可见的泄露
-- 只是因为客户端从来没渲染过它 —— 现在资料页要展示联系方式了，这个口子必须先堵上。
--
-- 默认 false（与 showPhone 同档，而不是 showWechat/showQQ 的 true）：注册邮箱是账号
-- 找回入口，属于「主动选择公开」而不是「默认公开」的字段。已有行一并按 false 落地，
-- 等于对存量用户执行一次收紧 —— 这是有意的，没有任何存量 UI 依赖 email 可见。
--
-- 可逆：DROP COLUMN 即可回滚，旧二进制不读这一列。无需抬 SCHEMA_COMPATIBILITY。
ALTER TABLE "UserPrivacySetting"
  ADD COLUMN "showEmail" BOOLEAN NOT NULL DEFAULT false;
