import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const migrationPath = join(
  root,
  'prisma/migrations/20260729120000_avatar_frame_wardrobe/migration.sql',
);
const selectedIndexMigrationPath = join(
  root,
  'prisma/migrations/20260729120500_avatar_frame_selected_index/migration.sql',
);

function prismaModel(schema: string, name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  if (start < 0) return '';
  const end = schema.indexOf('\n}', start);
  return end < 0 ? '' : schema.slice(start, end);
}

describe('avatar frame wardrobe persistence contract', () => {
  const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
  const sql = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';
  const selectedIndexSql = existsSync(selectedIndexMigrationPath)
    ? readFileSync(selectedIndexMigrationPath, 'utf8')
    : '';

  it('models the catalog, audited grants, and explicit user selection', () => {
    const asset = prismaModel(schema, 'AvatarFrameAsset');
    const grant = prismaModel(schema, 'UserAvatarFrameGrant');

    expect(asset).toMatch(/key\s+String\s+@unique/);
    expect(asset).toMatch(/minimumVipLevel\s+Int\?/);
    expect(asset).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(grant).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/);
    expect(grant).toMatch(/idempotencyKey\s+String\s+@unique/);
    expect(grant).toMatch(/reason\s+String/);
    expect(grant).toMatch(/expiresAt\s+DateTime\?/);
    expect(grant).toMatch(/revokedAt\s+DateTime\?/);
    expect(grant).toMatch(/revokedByUserID\s+String\?/);
    expect(grant).toMatch(/revokeReason\s+String\?/);
    expect(schema).toMatch(/selectedAvatarFrameID\s+String\?/);
    expect(schema).toMatch(/selectedAvatarFrameExpiresAt\s+DateTime\?/);
    expect(schema).toContain(
      '@relation("selectedAvatarFrame", fields: [selectedAvatarFrameID], references: [id], onDelete: SetNull)',
    );
    expect(schema).toContain(
      '@@index([userID, revokedAt, expiresAt], map: "UserAvatarFrameGrant_user_active_idx")',
    );
    expect(schema).toContain(
      '@@index([frameID, revokedAt, expiresAt], map: "UserAvatarFrameGrant_frame_active_idx")',
    );
    expect(schema).toContain(
      '@@index([userID, createdAt, id], map: "UserAvatarFrameGrant_user_createdAt_id_idx")',
    );
    expect(prismaModel(schema, 'User')).toContain(
      '@@index([selectedAvatarFrameID])',
    );
  });

  it('creates the catalog and grant tables with relational and idempotency safeguards', () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "AvatarFrameAsset"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "UserAvatarFrameGrant"');
    expect(selectedIndexSql).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_selectedAvatarFrameID_idx"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UserAvatarFrameGrant_idempotencyKey_key"',
    );
    expect(sql).toContain('User_selectedAvatarFrameID_fkey');
    expect(sql).toContain('UserAvatarFrameGrant_userID_fkey');
    expect(sql).toContain('UserAvatarFrameGrant_frameID_fkey');
    expect(sql).toContain('UserAvatarFrameGrant_operatorUserID_fkey');
    expect(sql).toContain('UserAvatarFrameGrant_revokedByUserID_fkey');
    expect(sql).toContain('UserAvatarFrameGrant_user_active_idx');
    expect(sql).toContain('UserAvatarFrameGrant_frame_active_idx');
    expect(sql).toContain('UserAvatarFrameGrant_user_createdAt_id_idx');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
  });

  it('makes every committed migration stage safe to resume after interruption', () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "selectedAvatarFrameID" TEXT/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "selectedAvatarFrameExpiresAt" TIMESTAMP\(3\)/,
    );
    expect(selectedIndexSql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_selectedAvatarFrameID_idx"/,
    );
    expect(
      selectedIndexSql
        .split(';')
        .filter((statement) => statement.trim().length > 0),
    ).toHaveLength(1);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "AvatarFrameAsset"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "UserAvatarFrameGrant"/);
    expect(sql).toMatch(/ON CONFLICT \("key"\) DO NOTHING/);
    for (const constraint of [
      'UserAvatarFrameGrant_userID_fkey',
      'UserAvatarFrameGrant_frameID_fkey',
      'UserAvatarFrameGrant_operatorUserID_fkey',
      'UserAvatarFrameGrant_revokedByUserID_fkey',
      'User_selectedAvatarFrameID_fkey',
    ]) {
      expect(sql).toContain(`WHERE conname = '${constraint}'`);
    }
  });

  it('releases the User DDL lock before backfill and validates its FK separately', () => {
    expect(sql).toMatch(/SET\s+lock_timeout\s*=\s*'[^']+'/i);

    const userAlter = sql.indexOf('ALTER TABLE "User"');
    const firstCommit = sql.indexOf('COMMIT;');
    const nextTransaction = sql.indexOf('BEGIN;', firstCommit);
    const assetTable = sql.indexOf(
      'CREATE TABLE IF NOT EXISTS "AvatarFrameAsset"',
    );
    const backfill = sql.indexOf('UPDATE "User" AS u');
    const foreignKey = sql.indexOf(
      'ADD CONSTRAINT "User_selectedAvatarFrameID_fkey"',
    );
    const notValid = sql.indexOf('NOT VALID', foreignKey);
    const validation = sql.indexOf(
      'VALIDATE CONSTRAINT "User_selectedAvatarFrameID_fkey"',
    );

    expect(firstCommit).toBeGreaterThan(userAlter);
    expect(assetTable).toBeGreaterThan(nextTransaction);
    expect(backfill).toBeGreaterThan(firstCommit);
    expect(foreignKey).toBeGreaterThan(firstCommit);
    expect(notValid).toBeGreaterThan(foreignKey);
    expect(validation).toBeGreaterThan(backfill);
    expect(sql.slice(foreignKey, notValid)).not.toContain('UPDATE "User"');
    expect(sql).toMatch(/RESET\s+lock_timeout\s*;\s*$/i);
  });

  it('seeds stable built-in keys and backfills only currently eligible users', () => {
    expect(sql).toMatch(
      /'membership-diamond'[\s\S]*?'Diamond Avatar Frame'[\s\S]*?3/,
    );
    expect(sql).toMatch(
      /'membership-super'[\s\S]*?'Super Avatar Frame'[\s\S]*?4/,
    );

    const backfill =
      /UPDATE "User" AS u([\s\S]*?)ALTER TABLE "User"\s+VALIDATE CONSTRAINT/.exec(
        sql,
      )?.[1] ?? '';
    expect(backfill).toMatch(
      /CASE\s+WHEN u\."vipLevel"\s*>=\s*4[\s\S]*?'membership-super'[\s\S]*?'membership-diamond'/i,
    );
    expect(backfill).toMatch(
      /"selectedAvatarFrameExpiresAt"\s*=\s*CASE\s+WHEN u\."vipLevel"\s*>=\s*4\s+THEN NULL\s+ELSE u\."vipExpiresAt"\s+END/i,
    );
    expect(backfill).toMatch(
      /u\."vipLevel"\s*>=\s*4\s+OR\s+\(\s*u\."vipLevel"\s*=\s*3[\s\S]*?u\."vipExpiresAt"\s+IS NULL[\s\S]*?u\."vipExpiresAt"\s*>\s*CURRENT_TIMESTAMP/i,
    );
    expect(backfill).not.toMatch(/u\."vipLevel"\s*<=?\s*2/i);
  });
});
