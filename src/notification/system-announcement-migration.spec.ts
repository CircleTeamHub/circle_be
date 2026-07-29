import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

describe('system announcement persistence contract', () => {
  const root = join(__dirname, '..', '..');
  const migrationPath = join(
    root,
    'prisma/migrations/20260729150000_system_announcement_idempotency/migration.sql',
  );

  it('persists an idempotency identity and one notification per recipient', () => {
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(
      /model SystemAnnouncement[\s\S]*idempotencyKey\s+String\s+@unique/,
    );
    expect(schema).toMatch(
      /model Notification[\s\S]*systemAnnouncementID\s+String\?/,
    );
    expect(schema).toContain(
      '@@unique([systemAnnouncementID, toUserID], map: "Notification_announcement_recipient_key")',
    );
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "Notification_announcement_recipient_key"',
    );
  });
});
