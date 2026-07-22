import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AdminAuditLog migration', () => {
  const root = join(__dirname, '../..');
  const migrationPath = join(
    root,
    'prisma/migrations/20260722090000_extend_admin_audit_log/migration.sql',
  );

  it('extends the shared audit table instead of creating a second one', () => {
    expect(existsSync(migrationPath)).toBe(true);

    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const sql = readFileSync(migrationPath, 'utf8');

    // 治理侧 20260721130000 已经建表，再 CREATE 一次会直接炸迁移。
    expect(sql).not.toContain('CREATE TABLE "AdminAuditLog"');
    expect(sql).toContain('ALTER TABLE "AdminAuditLog"');
    for (const column of ['actorAccountId', 'reason', 'metadata', 'requestId'])
      expect(sql).toContain(`ADD COLUMN "${column}"`);
    expect(sql).toContain('AdminAuditLog_action_createdAt_idx');

    // 全库只能有一个 AdminAuditLog 模型，两套定义 prisma validate 就过不去。
    expect(schema.match(/model AdminAuditLog\b/g)).toHaveLength(1);
  });
});
