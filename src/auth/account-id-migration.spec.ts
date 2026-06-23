import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Behavioural coverage for the `20260623000000_remove_account_id_prefix`
 * migration. The migration is raw SQL and this repo has no Postgres in the unit
 * test env, so we (1) mirror the SQL's transform + collision rule in TS and
 * assert the intended semantics, and (2) read migration.sql and assert it still
 * encodes the safety guards — so the mirror below can't silently drift from the
 * artifact that actually runs.
 */

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../prisma/migrations/20260623000000_remove_account_id_prefix/migration.sql',
);

// Mirror of the SQL's `accountId ~ '^ACC_[A-Z0-9]{6}$'` predicate.
const ACC_PREFIX_PATTERN = /^ACC_[A-Z0-9]{6}$/;

interface UserRow {
  id: string;
  accountId: string;
}

// Mirror of `lower(substring("accountId" FROM 5))` applied only to matching rows.
function migrateAccountId(accountId: string): string {
  return ACC_PREFIX_PATTERN.test(accountId)
    ? accountId.slice(4).toLowerCase()
    : accountId;
}

// Mirror of the DO $$ ... RAISE EXCEPTION pre-flight guard: a to-be-stripped id
// must not collide (case-insensitively) with any other row's current accountId.
function hasMigrationCollision(rows: UserRow[]): boolean {
  return rows.some((prefixed) => {
    if (!ACC_PREFIX_PATTERN.test(prefixed.accountId)) return false;
    const stripped = prefixed.accountId.slice(4).toLowerCase();
    return rows.some(
      (other) =>
        other.id !== prefixed.id && other.accountId.toLowerCase() === stripped,
    );
  });
}

describe('remove_account_id_prefix migration', () => {
  describe('transform rule', () => {
    it('strips the ACC_ prefix and lowercases a generated id', () => {
      expect(migrateAccountId('ACC_AB12CD')).toBe('ab12cd');
    });

    it('leaves an already-migrated lowercase id untouched', () => {
      expect(migrateAccountId('ab12cd')).toBe('ab12cd');
    });

    it('leaves a user-chosen handle untouched', () => {
      expect(migrateAccountId('alice_2024')).toBe('alice_2024');
    });

    it('ignores ids that do not match the exact ACC_ + 6 uppercase shape', () => {
      // wrong suffix length
      expect(migrateAccountId('ACC_ABC')).toBe('ACC_ABC');
      // lowercase suffix never matched the generator format, so it is left as-is
      expect(migrateAccountId('ACC_ab12cd')).toBe('ACC_ab12cd');
      // prefix-like but not the reserved form
      expect(migrateAccountId('ACCOUNT1')).toBe('ACCOUNT1');
    });
  });

  describe('collision guard', () => {
    it('passes when every stripped id stays unique', () => {
      const rows: UserRow[] = [
        { id: '1', accountId: 'ACC_AB12CD' },
        { id: '2', accountId: 'ACC_EF34GH' },
        { id: '3', accountId: 'alice_2024' },
      ];
      expect(hasMigrationCollision(rows)).toBe(false);
    });

    it('detects a stripped id colliding with an existing plain id', () => {
      const rows: UserRow[] = [
        { id: '1', accountId: 'ACC_AB12CD' },
        { id: '2', accountId: 'ab12cd' },
      ];
      expect(hasMigrationCollision(rows)).toBe(true);
    });

    it('detects a collision case-insensitively (the lower() on both sides)', () => {
      const rows: UserRow[] = [
        { id: '1', accountId: 'ACC_AB12CD' },
        { id: '2', accountId: 'AB12CD' },
      ];
      expect(hasMigrationCollision(rows)).toBe(true);
    });
  });

  describe('migration.sql artifact keeps its safety guards', () => {
    const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

    it('aborts on collision instead of corrupting data', () => {
      expect(sql).toContain('RAISE EXCEPTION');
    });

    it('normalizes to lowercase', () => {
      expect(sql).toContain('lower(');
    });

    it('only touches the reserved ACC_ + 6 uppercase format', () => {
      expect(sql).toContain('^ACC_[A-Z0-9]{6}$');
    });

    it('strips the 4-char ACC_ prefix via substring(... FROM 5)', () => {
      expect(sql).toMatch(/substring\([^)]*FROM 5\)/i);
    });
  });
});
