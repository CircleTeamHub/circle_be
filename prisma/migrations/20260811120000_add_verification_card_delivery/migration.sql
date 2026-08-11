-- 验证邀请卡片的投递补偿（配合 CircleInvitationService.issueVerificationCard）。
--
-- 卡片在 addVerifier 的席位事务提交后就地签发。签发失败此前是永久丢失：
-- 席位已落库，客户端重试会撞 @@unique([invitationID, verifierID]) 变成
-- AlreadyVerifier 冲突，而卡片没有任何服务端补偿路径。这两列让
-- sweepUndeliveredVerificationCards 能把漏掉的补回来。
ALTER TABLE "CircleInvitationVerifier"
  ADD COLUMN IF NOT EXISTS "cardDeliveredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cardAttempts" INTEGER NOT NULL DEFAULT 0;

-- 存量行视为「无需补投」：它们的邀请早已发出，卡片当年由客户端发（且必然失败）。
-- 不回填的话补偿任务上线后会给所有历史验证人重发一遍旧邀请卡。
UPDATE "CircleInvitationVerifier"
  SET "cardDeliveredAt" = "createdAt"
  WHERE "cardDeliveredAt" IS NULL;

-- 补偿任务每 5 分钟查 cardDeliveredAt IS NULL 的待补行。回填后全表几乎全是
-- 已送达行，无索引等于每轮顺序扫描；局部索引只覆盖待补行，体积恒小。
-- 与 CoinGift_pending_card_idx 同型：迁移跑在事务里用不了 CONCURRENTLY，
-- 大表部署可先手工 CREATE INDEX CONCURRENTLY 同名索引预建（本迁移即变 no-op）。
CREATE INDEX IF NOT EXISTS "CircleInvitationVerifier_pending_card_idx"
  ON "CircleInvitationVerifier"("createdAt")
  WHERE "cardDeliveredAt" IS NULL;
