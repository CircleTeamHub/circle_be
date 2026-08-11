-- 验证邀请卡片的投递补偿（配合 CircleInvitationService.issueVerificationCard）。
--
-- 卡片在 addVerifier 的席位事务提交后就地签发。签发失败此前是永久丢失：
-- 席位已落库，客户端重试会撞 @@unique([invitationID, verifierID]) 变成
-- AlreadyVerifier 冲突，而卡片没有任何服务端补偿路径。这两列让
-- sweepUndeliveredVerificationCards 能把漏掉的补回来。
ALTER TABLE "CircleInvitationVerifier"
  ADD COLUMN IF NOT EXISTS "cardDeliveredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cardAttempts" INTEGER NOT NULL DEFAULT 0;

-- 存量行回填，但**放过仍然有效的待验证席位**。
--
-- 不回填的话，补偿任务上线后会给所有历史验证人重发一遍早已了结的旧邀请卡。
-- 但一律回填又会误伤真正该补的那批：邀请没有过期机制，"席位 PENDING + 邀请
-- PENDING" 的行是**当前仍可操作**的请求，而它们的卡片当年由客户端发、必然失败
-- 过——那才是这次补偿要救的人。写死成已送达等于永久跳过他们。
-- 所以只回填「已了结」的行；活着的留空，交给 sweep 补投。
UPDATE "CircleInvitationVerifier" v
  SET "cardDeliveredAt" = v."createdAt"
  WHERE v."cardDeliveredAt" IS NULL
    AND NOT (
      v."status" = 'PENDING'
      AND EXISTS (
        SELECT 1 FROM "CircleInvitation" i
        WHERE i."id" = v."invitationID" AND i."status" = 'PENDING'
      )
    );

-- 补偿任务每 5 分钟查待补行。谓词必须同时带上 status = 'PENDING'：
-- invite() 建的「邀请人自动通过」那一席，以及已表态但当年 inline 失败的席位，
-- cardDeliveredAt 都会永久为 NULL。只按 cardDeliveredAt IS NULL 建索引的话，
-- 这些永远不会被处理的死行会一直留在索引里，而任务按 createdAt 从旧到新扫，
-- 每轮都要先趟过这堆历史才够得着真正待办的行 —— 索引与扫描成本随邀请总量增长，
-- 「局部索引体积恒小」的前提就不成立了。
-- 与 CoinGift_pending_card_idx 同型：迁移跑在事务里用不了 CONCURRENTLY，
-- 大表部署可先手工 CREATE INDEX CONCURRENTLY 同名索引预建（本迁移即变 no-op）。
CREATE INDEX IF NOT EXISTS "CircleInvitationVerifier_pending_card_idx"
  ON "CircleInvitationVerifier"("createdAt")
  WHERE "cardDeliveredAt" IS NULL AND "status" = 'PENDING';
