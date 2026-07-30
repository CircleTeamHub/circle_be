import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('leveled display icon dedupe migration', () => {
  it('keeps only the first persisted selection for each leveled badge type', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20260729170000_dedupe_leveled_display_icons/migration.sql',
    );

    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER/i);
    expect(sql).toMatch(/PARTITION BY\s+"userID",\s*"systemKey"/i);
    expect(sql).toMatch(/ORDER BY\s+"sortOrder"\s+ASC/i);
    expect(sql).toMatch(
      /"systemKey"\s+IN\s*\(\s*'VIP',\s*'TOP_COLLABORATOR'\s*\)/i,
    );
    expect(sql).toMatch(/DELETE FROM\s+"UserDisplayIcon"/i);
    expect(sql).toMatch(/ranked\."rowNumber"\s*>\s*1/i);
    expect(sql).toMatch(
      /BEGIN;[\s\S]*?LOCK TABLE\s+"UserDisplayIcon"\s+IN SHARE ROW EXCLUSIVE MODE;[\s\S]*?DELETE FROM\s+"UserDisplayIcon"[\s\S]*?CREATE UNIQUE INDEX[\s\S]*?COMMIT;/i,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?\("userID",\s*"systemKey"\)[\s\S]*?WHERE[\s\S]*?"systemKey"\s+IN\s*\(\s*'VIP',\s*'TOP_COLLABORATOR'\s*\)/i,
    );
  });
});
