import { readFileSync } from 'fs';
import { join } from 'path';

const migrationPath = join(
  process.cwd(),
  'prisma/migrations/20260722010000_restore_group_sync_outbox_idempotency/migration.sql',
);

describe('group sync desired-state migration', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  it('deduplicates open jobs by group and user, keeping the latest intent', () => {
    expect(sql).toContain('PARTITION BY "groupID", "userID"');
    expect(sql).toContain('ORDER BY "createdAt" DESC, "id" DESC');
    expect(sql).toContain('Superseded by newer desired group membership state');
  });

  it('accepts only the exact desired or archived legacy index definition', () => {
    expect(sql).toContain("key_columns = ARRAY['groupID', 'userID']::text[]");
    expect(sql).toContain(
      "key_columns = ARRAY['operation', 'groupID', 'userID']::text[]",
    );
    expect(sql).toContain('Unexpected definition for index');
    expect(sql).toContain('DROP INDEX "GroupSyncOutbox_open_active_key"');
  });

  it('creates one open desired-state job per group and user', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "GroupSyncOutbox_open_active_key"\s+ON "GroupSyncOutbox"\("groupID", "userID"\)/,
    );
    expect(sql).not.toMatch(
      /CREATE UNIQUE INDEX "GroupSyncOutbox_open_active_key"\s+ON "GroupSyncOutbox"\("operation",/,
    );
  });
});
