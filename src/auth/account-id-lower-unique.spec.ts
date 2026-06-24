import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Coverage for the `20260623010000_account_id_lower_unique` migration, which
 * pushes the case-insensitive-uniqueness invariant down to the DB so it no
 * longer relies solely on the app layer always writing lowercase.
 *
 * No Postgres in the unit-test env, so we (1) mirror the `lower(accountId)`
 * uniqueness rule the functional index enforces and assert its semantics, and
 * (2) read migration.sql and assert it still encodes that exact index — so the
 * mirror can't silently drift from the artifact that actually runs.
 */

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../prisma/migrations/20260623010000_account_id_lower_unique/migration.sql',
);

// Mirror of the functional unique index: two rows conflict iff their accountIds
// are equal after lower(). This is the invariant the DB now guarantees.
function hasCaseInsensitiveDuplicate(accountIds: string[]): boolean {
  const seen = new Set<string>();
  for (const id of accountIds) {
    const key = id.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

describe('account_id_lower_unique migration', () => {
  describe('case-insensitive uniqueness rule', () => {
    it('rejects ids differing only by case', () => {
      expect(hasCaseInsensitiveDuplicate(['alice', 'Alice'])).toBe(true);
    });

    it('rejects mixed-case variants of the same handle', () => {
      expect(hasCaseInsensitiveDuplicate(['Bob_2024', 'bob_2024'])).toBe(true);
    });

    it('allows genuinely distinct handles', () => {
      expect(hasCaseInsensitiveDuplicate(['alice', 'bob', 'carol_2024'])).toBe(
        false,
      );
    });
  });

  describe('migration.sql artifact', () => {
    const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

    it('creates a UNIQUE index', () => {
      expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    });

    it('keys the index on lower(accountId), not the raw column', () => {
      expect(sql).toMatch(/lower\(\s*"accountId"\s*\)/i);
    });
  });
});
