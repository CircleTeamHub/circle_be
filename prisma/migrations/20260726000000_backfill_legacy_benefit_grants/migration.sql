-- Backfill 靓号券给启用会员权限前已在 3/4 档、且仍有效（vipExpiresAt 为 null 或未过期）的老会员。
-- 新表 MembershipBenefitGrant 初始为空，且 admin grant 端点拒绝「同级不算升级」，导致 legacy
-- diamond 永远拿不到标准券、legacy super/VIP5 永远拿不到高级券（/membership/me 却报「可用」而无
-- 发放路径）。这里补发：diamond(3) → STANDARD_FANCY_NUMBER；super(4) → PREMIUM_FANCY_NUMBER。
--
-- 券必须挂在 MembershipGrant（审计）上（FK），故为每人合成一条 legacy 系统 grant：operator = 目标
-- 自身（满足 operatorUserID 的 FK，同时把它标为「系统/legacy」而非某个管理员），note 说明来由。
-- 幂等：idempotencyKey 唯一 + (userID,type) 唯一 + ON CONFLICT DO NOTHING + NOT EXISTS 预过滤，
-- 迁移在事务内原子执行，重跑或补跑都不会重复发放。
WITH legacy AS (
  SELECT
    u."id" AS user_id,
    u."vipLevel" AS level,
    (
      CASE WHEN u."vipLevel" = 3 THEN 'STANDARD_FANCY_NUMBER'
           ELSE 'PREMIUM_FANCY_NUMBER' END
    )::"MembershipBenefitType" AS benefit_type
  FROM "User" u
  WHERE u."vipLevel" >= 3
    AND (u."vipExpiresAt" IS NULL OR u."vipExpiresAt" > CURRENT_TIMESTAMP)
    AND NOT EXISTS (
      SELECT 1
      FROM "MembershipBenefitGrant" bg
      WHERE bg."userID" = u."id"
        AND bg."type" = (
          CASE WHEN u."vipLevel" = 3 THEN 'STANDARD_FANCY_NUMBER'
               ELSE 'PREMIUM_FANCY_NUMBER' END
        )::"MembershipBenefitType"
    )
),
grant_ins AS (
  INSERT INTO "MembershipGrant" (
    "id", "idempotencyKey", "targetUserID", "operatorUserID",
    "previousLevel", "previousEffectiveLevel", "newLevel",
    "benefitTypesSnapshot", "note"
  )
  SELECT
    gen_random_uuid()::text,
    'legacy-benefit-backfill:' || l.user_id || ':' || l.benefit_type::text,
    l.user_id,
    l.user_id,
    l.level,
    l.level,
    l.level,
    ARRAY[l.benefit_type]::"MembershipBenefitType"[],
    'Legacy benefit backfill for pre-rollout high-tier member'
  FROM legacy l
  ON CONFLICT ("idempotencyKey") DO NOTHING
  RETURNING "id", "targetUserID"
)
INSERT INTO "MembershipBenefitGrant" ("id", "userID", "membershipGrantID", "type")
SELECT
  gen_random_uuid()::text,
  g."targetUserID",
  g."id",
  l.benefit_type
FROM grant_ins g
JOIN legacy l ON l.user_id = g."targetUserID"
ON CONFLICT ("userID", "type") DO NOTHING;
