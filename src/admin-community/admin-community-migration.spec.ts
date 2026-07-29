import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

describe('admin community management persistence contract', () => {
  const root = join(__dirname, '..', '..');

  it('adds recoverable circle state, durable group operations, and non-blocking dashboard indexes', () => {
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const sql = readFileSync(
      join(
        root,
        'prisma/migrations/20260729130000_admin_operations_dashboard/migration.sql',
      ),
      'utf8',
    );
    const dismissedSql = readFileSync(
      join(
        root,
        'prisma/migrations/20260729140000_admin_circle_dismissed_state/migration.sql',
      ),
      'utf8',
    );
    const dashboardIndexPath = join(
      root,
      'prisma/migrations/20260729131000_admin_dashboard_indexes/migration.sql',
    );

    expect(schema).toMatch(
      /enum CircleAdminState[\s\S]*SYNC_FAILED[\s\S]*DISMISSED/,
    );
    expect(schema).toMatch(/model AdminGroupOperation[\s\S]*idempotencyKey/);
    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql).toContain('AdminGroupOperation_active_group_key');
    expect(sql).toMatch(/WHERE "status" IN \('PENDING', 'PROCESSING'\)/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toContain('User_lastOnline_idx');
    expect(existsSync(dashboardIndexPath)).toBe(true);
    const dashboardIndexSql = readFileSync(dashboardIndexPath, 'utf8');
    expect(dashboardIndexSql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_lastOnline_idx"',
    );
    expect(dashboardIndexSql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "CoinTransaction_type_createdAt_idx"',
    );
    expect(dashboardIndexSql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "CircleMember_status_createdAt_idx"',
    );
    expect(dashboardIndexSql).not.toMatch(/\b(BEGIN|COMMIT)\s*;/);
    expect(dismissedSql).toContain(
      `ALTER TYPE "CircleAdminState" ADD VALUE IF NOT EXISTS 'DISMISSED'`,
    );
  });
});
