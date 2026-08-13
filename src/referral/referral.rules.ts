import { ConfigService } from '@nestjs/config';
import { Prisma } from 'src/generated/prisma';
import { REFERRAL_DEFAULTS, REFERRAL_MS_PER_DAY } from './referral.constants';

export type ReferralRules = {
  enabled: boolean;
  inviterReward: number;
  inviteeReward: number;
  qualificationDays: number;
  expiryDays: number;
  monthlyCap: number;
};

export function readReferralRules(config: ConfigService): ReferralRules {
  return {
    enabled: readBoolean(
      config.get('REFERRAL_REWARDS_ENABLED'),
      REFERRAL_DEFAULTS.enabled,
    ),
    inviterReward: readPositiveInt(
      config.get('REFERRAL_INVITER_REWARD'),
      REFERRAL_DEFAULTS.inviterReward,
    ),
    inviteeReward: readPositiveInt(
      config.get('REFERRAL_INVITEE_REWARD'),
      REFERRAL_DEFAULTS.inviteeReward,
    ),
    qualificationDays: readPositiveInt(
      config.get('REFERRAL_QUALIFICATION_DAYS'),
      REFERRAL_DEFAULTS.qualificationDays,
    ),
    expiryDays: readPositiveInt(
      config.get('REFERRAL_EXPIRY_DAYS'),
      REFERRAL_DEFAULTS.expiryDays,
    ),
    monthlyCap: readPositiveInt(
      config.get('REFERRAL_MONTHLY_CAP'),
      REFERRAL_DEFAULTS.monthlyCap,
    ),
  };
}

export function buildPendingReferralData(
  rules: ReferralRules,
  input: { inviterId: string; inviteeId: string; createdAt: Date },
): Prisma.ReferralUncheckedCreateInput {
  const eligibleAt = new Date(
    input.createdAt.getTime() + rules.qualificationDays * REFERRAL_MS_PER_DAY,
  );
  return {
    inviterID: input.inviterId,
    inviteeID: input.inviteeId,
    status: rules.enabled ? 'PENDING' : 'REJECTED',
    inviterReward: rules.inviterReward,
    inviteeReward: rules.inviteeReward,
    eligibleAt,
    nextCheckAt: eligibleAt,
    expiresAt: new Date(
      input.createdAt.getTime() + rules.expiryDays * REFERRAL_MS_PER_DAY,
    ),
    ...(!rules.enabled ? { failureReason: 'CAMPAIGN_DISABLED' } : {}),
  };
}

function readPositiveInt(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function readBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    if (raw.toLowerCase() === 'true') return true;
    if (raw.toLowerCase() === 'false') return false;
  }
  return fallback;
}
