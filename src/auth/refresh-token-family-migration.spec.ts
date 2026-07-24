import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('refresh-token family migration', () => {
  const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260722190000_refresh_token_family_and_revocation_reason/migration.sql',
  );

  it('backfills isolated families and keeps historical revocation reasons unknown', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TYPE "RefreshTokenRevocationReason"');
    expect(sql).toMatch(
      /ADD COLUMN "familyId" TEXT DEFAULT \(\s*gen_random_uuid\(\)\s*::text\s*\)/i,
    );
    expect(sql).toContain(
      'ADD COLUMN "revocationReason" "RefreshTokenRevocationReason"',
    );
    expect(sql).toMatch(/SET "familyId" = "id"/i);
    expect(sql).not.toMatch(/ALTER COLUMN "familyId" SET DEFAULT/i);
    expect(sql).toContain('ALTER COLUMN "familyId" SET NOT NULL');
    expect(sql).not.toMatch(/SET\s+"revocationReason"\s*=/i);
    expect(sql).toContain('RefreshToken_userId_familyId_idx');
    expect(sql).toContain('RefreshToken_userId_audience_createdAt_idx');
  });

  it('wraps the migration in an explicit transaction so deploy retries do not see partial enum or column state', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/^\s*BEGIN;\s+CREATE\s+EXTENSION/i);
    expect(sql).toMatch(/CREATE\s+INDEX[\s\S]+;\s*COMMIT;\s*$/i);
  });
});
