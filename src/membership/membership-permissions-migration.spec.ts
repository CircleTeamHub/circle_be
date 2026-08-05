import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('membership permissions migration', () => {
  it('normalizes legacy VIP5 users and display-icon selections to VIP4', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20260722000000_membership_permissions/migration.sql',
    );
    const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    expect(sql).toMatch(/UPDATE "User"/i);
    expect(sql).toMatch(/SET "vipLevel"\s*=\s*4/i);
    expect(sql).toMatch(/WHERE "vipLevel"\s*>\s*4/i);
    expect(sql).toMatch(/DELETE FROM "UserDisplayIcon"/i);
    expect(sql).toMatch(/"systemVariant"\s*=\s*'VIP5'/i);
    expect(sql).toMatch(/UPDATE "UserDisplayIcon"/i);
    expect(sql).toMatch(/SET "systemVariant"\s*=\s*'VIP4'/i);
    expect(sql).toMatch(/CHECK \("vipLevel" BETWEEN 0 AND 4\)/i);
  });
});
