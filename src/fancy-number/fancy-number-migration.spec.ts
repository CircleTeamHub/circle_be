import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..');

describe('fancy number persistence contract', () => {
  it('defines account claims, inventory, leases, orders and user expiry snapshots', () => {
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');

    expect(schema).toContain('model AccountIdentifier');
    expect(schema).toContain('model FancyNumber');
    expect(schema).toContain('model FancyNumberLease');
    expect(schema).toContain('model FancyNumberOrder');
    expect(schema).toMatch(/fancyNumberExpiresAt\s+DateTime\?/);
    expect(schema).toMatch(
      /fancyNumberPermanent\s+Boolean\s+@default\(false\)/,
    );
  });

  it('preflights normalized collisions before backfill and enforces one active lease', () => {
    const sql = readFileSync(
      join(
        root,
        'prisma/migrations/20260728000000_fancy_number_marketplace/migration.sql',
      ),
      'utf8',
    );

    expect(sql.indexOf('account identifier collision')).toBeLessThan(
      sql.indexOf('INSERT INTO "AccountIdentifier"'),
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "FancyNumberLease_active_user_key"[\s\S]*WHERE "endedAt" IS NULL/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "FancyNumberLease_active_number_key"[\s\S]*WHERE "endedAt" IS NULL/,
    );
    expect(sql).toContain('User_account_identifier_prepare');
    expect(sql).toContain('User_account_identifier_assign');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('ORDER BY identifier');
    expect(sql).toContain('AccountIdentifier_lock_value_trigger');
    const prepareStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION "User_account_identifier_prepare"',
    );
    const cleanupStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION "User_account_identifier_cleanup"',
    );
    expect(cleanupStart).toBeGreaterThan(prepareStart);
    expect(sql.slice(prepareStart, cleanupStart)).not.toContain(
      'DELETE FROM "AccountIdentifier"',
    );
    expect(sql.slice(cleanupStart)).toContain(
      'DELETE FROM "AccountIdentifier"',
    );
    expect(sql).toMatch(
      /CREATE TRIGGER "User_account_identifier_cleanup_trigger"[\s\S]*AFTER UPDATE OF "accountId", "inviteCode"/,
    );
    const forwardSql = readFileSync(
      join(
        root,
        'prisma/migrations/20260729160000_account_identifier_cleanup_trigger/migration.sql',
      ),
      'utf8',
    );
    const forwardPrepareStart = forwardSql.indexOf(
      'CREATE OR REPLACE FUNCTION "User_account_identifier_prepare"',
    );
    const forwardCleanupStart = forwardSql.indexOf(
      'CREATE OR REPLACE FUNCTION "User_account_identifier_cleanup"',
    );
    expect(
      forwardSql.slice(forwardPrepareStart, forwardCleanupStart),
    ).not.toContain('DELETE FROM "AccountIdentifier"');
    expect(forwardSql.slice(forwardCleanupStart)).toContain(
      'AFTER UPDATE OF "accountId", "inviteCode"',
    );
  });

  it('adds an auditable order type for permanent-number switching', () => {
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const sql = readFileSync(
      join(
        root,
        'prisma/migrations/20260728180000_fancy_number_switch/migration.sql',
      ),
      'utf8',
    );

    expect(schema).toMatch(/enum FancyNumberOrderType[\s\S]*\bSWITCH\b/);
    expect(sql).toContain(
      'ALTER TYPE "FancyNumberOrderType" ADD VALUE \'SWITCH\'',
    );
  });

  it('adds a source value for user-created custom fancy numbers', () => {
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const sql = readFileSync(
      join(
        root,
        'prisma/migrations/20260728190000_custom_fancy_numbers/migration.sql',
      ),
      'utf8',
    );

    expect(schema).toMatch(/enum FancyNumberSource[\s\S]*\bCUSTOM\b/);
    expect(sql).toContain(
      'ALTER TYPE "FancyNumberSource" ADD VALUE \'CUSTOM\'',
    );
  });

  it('adds a non-destructive curated recommendation flag with a bounded backfill', () => {
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const sql = readFileSync(
      join(
        root,
        'prisma/migrations/20260729010000_fancy_number_recommendations/migration.sql',
      ),
      'utf8',
    );

    expect(schema).toMatch(/isRecommended\s+Boolean\s+@default\(false\)/);
    expect(schema).toContain(
      '@@index([isRecommended, status, sortOrder, id], map: "FancyNumber_recommended_status_sort_idx")',
    );
    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql).toContain('LIMIT 100');
    expect(sql.indexOf('LIMIT 100')).toBeLessThan(
      sql.indexOf('SET "isRecommended" = true'),
    );
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
  });
});
