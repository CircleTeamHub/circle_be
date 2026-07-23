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
    expect(sql).toContain('ADD COLUMN "familyId" TEXT');
    expect(sql).toContain(
      'ADD COLUMN "revocationReason" "RefreshTokenRevocationReason"',
    );
    expect(sql).toMatch(/SET "familyId" = "id"\s+WHERE "familyId" IS NULL/i);
    expect(sql).toContain('ALTER COLUMN "familyId" SET NOT NULL');
    expect(sql).not.toContain('ALTER COLUMN "familyId" SET DEFAULT');
    expect(sql).not.toMatch(/SET\s+"revocationReason"\s*=/i);
    expect(sql).toContain('RefreshToken_userId_familyId_idx');
    expect(sql).toContain('RefreshToken_userId_audience_createdAt_idx');
  });
});
