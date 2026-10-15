import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('session access revocation migrations', () => {
  it('adds independent durable access-token state without rewriting rotation audit fields', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261015000000_add_session_access_revocation/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3)');
    expect(sql).toContain('ADD COLUMN "accessRevokedAt" TIMESTAMP(3)');
    expect(sql).toContain(
      'ADD COLUMN "accessRevocationNotifiedAt" TIMESTAMP(3)',
    );
    expect(sql).toContain('ADD COLUMN "accessRevocationLockedAt" TIMESTAMP(3)');
    expect(sql).toContain('ADD COLUMN "accessRevocationLeaseToken" TEXT');
    expect(sql).not.toContain('revocationReason');
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });

  it('builds the hot-table lookup index concurrently in a separate migration', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261015000100_index_session_access_revocation/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(sql).toContain('RefreshToken_access_revoke_outbox_idx');
    expect(sql).toContain('("accessTokenExpiresAt", "expiredAt", "id")');
    expect(sql).toContain('WHERE "accessRevokedAt" IS NOT NULL');
    expect(sql).toContain('AND "accessRevocationNotifiedAt" IS NULL');
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });
});
