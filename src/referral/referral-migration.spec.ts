import { readFileSync } from 'fs';
import { join } from 'path';

describe('referral rewards migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260813030000_add_referral_rewards/migration.sql',
    ),
    'utf8',
  );

  it('adds a unique invitee lifecycle and idempotent ledger transaction types', () => {
    expect(sql).toContain('CREATE TABLE "Referral"');
    expect(sql).toContain('CREATE UNIQUE INDEX "Referral_inviteeID_key"');
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'REFERRAL_REWARD'");
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'REFERRAL_BONUS'");
  });

  it('does not backfill unverifiable historical invite relationships', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"Referral"/i);
  });
});
