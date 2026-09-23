import { readFileSync } from 'fs';
import { join } from 'path';

describe('rolling self-destruct boundary compatibility migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260922000000_guard_self_destruct_boundaries/migration.sql',
    ),
    'utf8',
  );

  it('fills and clears conversation boundaries for old writers', () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF "burnDurationSec"');
    expect(sql).toMatch(/NEW\."burnDurationSec"\s*>\s*0/);
    expect(sql).toMatch(/NEW\."burnStartedAt"\s*:=\s*clock_timestamp\(\)/);
    expect(sql).toMatch(/NEW\."burnStartedAt"\s*:=\s*NULL/);
  });

  it('does the same for account-level self-destruct settings', () => {
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OF "messageSelfDestructSec"',
    );
    expect(sql).toMatch(
      /NEW\."messageSelfDestructStartedAt"\s*:=\s*clock_timestamp\(\)/,
    );
    expect(sql).toMatch(/NEW\."messageSelfDestructStartedAt"\s*:=\s*NULL/);
  });
});
