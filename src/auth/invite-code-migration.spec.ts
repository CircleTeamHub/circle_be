import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('registration invite-code migration', () => {
  it('backfills stable invite codes and preserves invitees when an inviter is deleted', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20260715000000_add_registration_invite_codes/migration.sql',
    );
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    expect(sql).toMatch(/ADD COLUMN\s+"inviteCode"\s+TEXT/i);
    expect(sql).toMatch(/SET\s+"inviteCode"\s*=\s*lower\("accountId"\)/i);
    expect(sql).toMatch(/"User_inviteCode_key".*UNIQUE/i);
    expect(sql).toMatch(/ON DELETE SET NULL/i);
  });

  it('uppercases stored invite codes while keeping the shared identifier registry lowercase', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20260814000000_uppercase_invite_codes/migration.sql',
    );
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    expect(sql).toContain('NEW."inviteCode" := upper(NEW."inviteCode")');
    expect(sql).toContain('new_invite_identifier := lower(NEW."inviteCode")');
    expect(sql).toContain('invite_identifier TEXT := lower(NEW."inviteCode")');
    expect(sql).toMatch(
      /UPDATE "User"[\s\S]*SET "inviteCode" = upper\("inviteCode"\)/,
    );
  });

  // review 修复：事务级 advisory 锁到 COMMIT 才释放。回填 UPDATE 扫全表时逐行
  // 无条件加锁会把共享锁表撑爆（5000 行实测累积 10000 把锁），迁移 out of shared
  // memory 直接中止。只在规范化标识符真的变化时加锁，回填这类纯改大小写的
  // UPDATE 一把锁都不需要。
  it('only takes claim locks for identifiers the row actually changes', () => {
    const migrationPath = join(
      process.cwd(),
      'prisma/migrations/20260814000000_uppercase_invite_codes/migration.sql',
    );
    const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    const lockBlock = sql.slice(
      sql.indexOf('PERFORM pg_advisory_xact_lock'),
      sql.indexOf("IF TG_OP = 'INSERT' THEN"),
    );
    expect(lockBlock).toContain('pg_advisory_xact_lock');
    expect(lockBlock).toContain(
      'WHERE identifier IS DISTINCT FROM previous_identifier',
    );
    expect(lockBlock).toContain(
      '(new_account_identifier, old_account_identifier)',
    );
    expect(lockBlock).toContain(
      '(new_invite_identifier, old_invite_identifier)',
    );
    // 死锁顺序保护不能因为这次改动丢掉。
    expect(lockBlock).toContain('ORDER BY identifier');
  });

  // review 修复：默认蓝绿模式下旧色在迁移期间仍在服务，而发布前的二进制按小写
  // 查邀请码，全表大写化后它一条都查不到。这个版本必须走"先停旧色再迁移"的停机
  // 路径，且迁移后旧二进制不再是合法回滚目标 —— 两个闸门都锁在仓库文件里。
  it('keeps the backfill out of a blue-green window', () => {
    const marker = join(
      process.cwd(),
      'deploy/REQUIRES_IRREVERSIBLE_MIGRATION',
    );
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain('20260814000000');

    const compatibility = Number(
      readFileSync(
        join(process.cwd(), 'deploy/SCHEMA_COMPATIBILITY'),
        'utf8',
      ).trim(),
    );
    expect(compatibility).toBeGreaterThanOrEqual(4);
  });
});
