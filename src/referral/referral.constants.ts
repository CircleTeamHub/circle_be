export const REFERRAL_DEFAULTS = {
  enabled: true,
  inviterReward: 20,
  inviteeReward: 5,
  qualificationDays: 7,
  expiryDays: 30,
  monthlyCap: 10,
} as const;

export const REFERRAL_BATCH_SIZE = 100;
export const REFERRAL_LIST_DEFAULT_LIMIT = 20;
export const REFERRAL_LIST_MAX_LIMIT = 50;
export const REFERRAL_MS_PER_DAY = 24 * 60 * 60 * 1000;
export const REFERRAL_RECHECK_MS = 6 * 60 * 60 * 1000;
