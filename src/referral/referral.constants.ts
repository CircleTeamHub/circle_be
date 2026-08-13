export const REFERRAL_DEFAULTS = {
  enabled: true,
  inviterReward: 20,
  inviteeReward: 5,
  qualificationDays: 7,
  expiryDays: 30,
  monthlyCap: 10,
} as const;

export const REFERRAL_BATCH_SIZE = 100;
/** 一次扫描最多连抽多少批,配合 BUDGET_MS 给排空循环一个硬兜底。 */
export const REFERRAL_SWEEP_MAX_BATCHES = 50;
/** 单次扫描的运行预算,远小于 EVERY_HOUR 的间隔,不与下一次触发叠在一起。 */
export const REFERRAL_SWEEP_BUDGET_MS = 10 * 60 * 1000;
/**
 * 结算宽限:定时器是整点跑的,`nextCheckAt` 被夹到 `expiresAt` 的那次终检
 * 必然落在 expiresAt 之后一点点。没有宽限的话，卡在窗口最后一段时间里
 * 达成条件的人会被判 EXPIRED —— 明明是我们自己晚到了。
 */
export const REFERRAL_SETTLEMENT_GRACE_MS = 2 * 60 * 60 * 1000;
/** 单笔奖励上限。落库列是 PostgreSQL INTEGER,业务上也没有更大的合理值。 */
export const REFERRAL_MAX_REWARD = 100_000;
export const REFERRAL_LIST_DEFAULT_LIMIT = 20;
export const REFERRAL_LIST_MAX_LIMIT = 50;
export const REFERRAL_MS_PER_DAY = 24 * 60 * 60 * 1000;
export const REFERRAL_RECHECK_MS = 6 * 60 * 60 * 1000;
