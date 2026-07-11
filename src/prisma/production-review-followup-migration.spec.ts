import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../prisma/migrations/20260711000000_production_review_followup/migration.sql',
);
const SCHEMA_PATH = join(__dirname, '../../prisma/schema.prisma');

describe('production review follow-up migration', () => {
  it('restores rolling-deploy compatibility and adds worker ownership state', () => {
    const sql = existsSync(MIGRATION_SQL_PATH)
      ? readFileSync(MIGRATION_SQL_PATH, 'utf8')
      : '';

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "isPublic"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "generation"');
    expect(sql.match(/ADD COLUMN IF NOT EXISTS "leaseToken"/g)).toHaveLength(3);
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'TERMINAL'");
  });

  it('keeps the final Prisma schema aligned with the forward migration', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');

    expect(schema).toContain('TERMINAL');
    expect(schema).toMatch(/generation\s+Int\s+@default\(0\)/);
    expect(schema.match(/leaseToken\s+String\?/g)).toHaveLength(3);
    expect(schema).toContain('isPublic');
  });
});
