import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AdminAuditLog migration', () => {
  const root = join(__dirname, '../..');
  const migrationPath = join(
    root,
    'prisma/migrations/20260722090000_add_admin_audit_log/migration.sql',
  );

  it('defines the append-only audit model and lookup indexes', () => {
    expect(existsSync(migrationPath)).toBe(true);

    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const sql = readFileSync(migrationPath, 'utf8');

    expect(schema).toContain('model AdminAuditLog');
    expect(sql).toContain('CREATE TABLE "AdminAuditLog"');
    expect(sql).toContain(
      'AdminAuditLog_targetType_targetId_createdAt_idx',
    );
    expect(sql).toContain('AdminAuditLog_actorId_createdAt_idx');
    expect(sql).toContain('AdminAuditLog_action_createdAt_idx');
  });
});
