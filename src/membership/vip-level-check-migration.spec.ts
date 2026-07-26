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

    // 并加 0..4 的 CHECK 约束，挡住蓝绿窗口里旧色（DTO 上限仍是 10）新写入的不可达 VIP5+ 门槛。
    expect(sql).toMatch(/ADD CONSTRAINT "Circle_joinVipRestriction_check"/i);
    expect(sql).toMatch(/ADD CONSTRAINT "CirclePost_vipRestriction_check"/i);
    expect(sql).toMatch(
      /ADD CONSTRAINT "CirclePost_signupVipRestriction_check"/i,
    );
    expect(sql).toMatch(/"joinVipRestriction" IS NULL OR/i);

    // 每个 CHECK 约束在 ADD 前都要 DROP IF EXISTS，迁移才能重跑（部署脚本重试 / 手工
    // 补跑不会因 42710 duplicate_object 炸掉）。与 User_vipLevel_check 的处理保持一致。
    for (const name of [
      'Circle_joinVipRestriction_check',
      'CirclePost_vipRestriction_check',
      'CirclePost_signupVipRestriction_check',
    ]) {
      const dropIdx = sql.search(
        new RegExp(`DROP CONSTRAINT IF EXISTS "${name}"`, 'i'),
      );
      const addIdx = sql.search(new RegExp(`ADD CONSTRAINT "${name}"`, 'i'));
      expect(dropIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThan(dropIdx);
    }
  });
});
