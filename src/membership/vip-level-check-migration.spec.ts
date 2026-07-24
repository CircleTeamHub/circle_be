import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('VIP level check migration', () => {
  it('limits VIP levels to the supported four-tier product definition', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20260724080000_limit_vip_level_to_4/migration.sql',
    );

    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/UPDATE "User"/i);
    expect(sql).toMatch(/SET "vipLevel"\s*=\s*4/i);
    expect(sql).toMatch(/WHERE "vipLevel"\s*>\s*4/i);
    expect(sql).toMatch(/DELETE FROM "UserDisplayIcon"/i);
    expect(sql).toMatch(/"systemVariant"\s*=\s*'VIP5'/i);
    expect(sql).toMatch(/UPDATE "UserDisplayIcon"/i);
    expect(sql).toMatch(/SET "systemVariant"\s*=\s*'VIP4'/i);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS "User_vipLevel_check"/i);
    expect(sql).toMatch(/ADD CONSTRAINT "User_vipLevel_check"/i);
    expect(sql).toMatch(/"vipLevel"\s*<=\s*4/i);
    expect(sql).not.toMatch(/"vipLevel"\s*<=\s*5/i);

    // 圈子/帖子的历史 VIP 门槛也一并夹到 4，否则原本配 VIP5 门槛的内容收口后无人可达。
    expect(sql).toMatch(/UPDATE "Circle"[\s\S]*?"joinVipRestriction"\s*=\s*4/i);
    expect(sql).toMatch(/UPDATE "CirclePost"[\s\S]*?"vipRestriction"\s*=\s*4/i);
    expect(sql).toMatch(/"signupVipRestriction"\s*=\s*4/i);
  });
});
