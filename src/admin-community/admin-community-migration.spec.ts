import { readFileSync } from 'fs';
import { join } from 'path';

describe('admin community management persistence contract', () => {
  const root = join(__dirname, '..', '..');

  it('adds recoverable circle state, durable group operations, and dashboard indexes', () => {
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

    expect(schema).toMatch(
      /enum CircleAdminState[\s\S]*SYNC_FAILED[\s\S]*DISMISSED/,
    );
    expect(schema).toMatch(/model AdminGroupOperation[\s\S]*idempotencyKey/);
    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql).toContain('AdminGroupOperation_active_group_key');
    expect(sql).toMatch(/WHERE "status" IN \('PENDING', 'PROCESSING'\)/);
    expect(sql).toContain('User_lastOnline_idx');
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(dismissedSql).toContain(
      `ALTER TYPE "CircleAdminState" ADD VALUE IF NOT EXISTS 'DISMISSED'`,
    );
  });
});
