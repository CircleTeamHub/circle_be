import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../prisma/migrations/20260722000000_membership_permissions/migration.sql',
);

describe('membership permissions migration', () => {
  const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

  it.each(['vipRestriction', 'signupVipRestriction'])(
    'normalizes legacy CirclePost.%s values into nullable levels 1 through 4',
    (column) => {
      const start = sql.indexOf(`UPDATE "CirclePost"\nSET "${column}"`);
      const end = sql.indexOf('\n\n', start);
      const update = sql.slice(start, end);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(update).toContain(`WHEN "${column}" <= 0 THEN NULL`);
      expect(update).toContain(`WHEN "${column}" > 4 THEN 4`);
    },
  );

  it.each([
    ['CirclePost_vipRestriction_check', 'vipRestriction'],
    ['CirclePost_signupVipRestriction_check', 'signupVipRestriction'],
  ])('adds nullable 1-4 constraint %s', (constraint, column) => {
    expect(sql).toContain(`ADD CONSTRAINT "${constraint}"`);
    expect(sql).toContain(
      `CHECK ("${column}" IS NULL OR "${column}" BETWEEN 1 AND 4)`,
    );
  });
});
