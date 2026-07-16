import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('registration invite-code migration', () => {
  it('backfills stable invite codes and preserves invitees when an inviter is deleted', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20260715000000_add_registration_invite_codes/migration.sql',
    );
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/ADD COLUMN\s+"inviteCode"\s+TEXT/i);
    expect(sql).toMatch(/SET\s+"inviteCode"\s*=\s*lower\("accountId"\)/i);
    expect(sql).toMatch(/"User_inviteCode_key".*UNIQUE/i);
    expect(sql).toMatch(/ON DELETE SET NULL/i);
  });
});
