import { readFileSync } from 'fs';
import { join } from 'path';

const migrationPath = join(
  process.cwd(),
  'prisma/migrations/20260722010000_restore_group_sync_outbox_idempotency/migration.sql',
);

describe('group sync desired-state migration', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  it('rolls back dedupe, probes, and index replacement on validation failure', () => {
    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql.indexOf('BEGIN;')).toBeLessThan(
      sql.indexOf('WITH ranked_desired'),
    );
    expect(sql.lastIndexOf('COMMIT;')).toBeGreaterThan(
      sql.lastIndexOf('DROP INDEX'),
    );
  });

  it('deduplicates open jobs by group and user, keeping the latest intent', () => {
    expect(sql).toContain('PARTITION BY "groupID", "userID"');
    expect(sql).toContain('job."createdAt" DESC');
    expect(sql).toContain('retain it separately so lease recovery replays');
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
      /CREATE UNIQUE INDEX "GroupSyncOutbox_desired_state_key"\s+ON "GroupSyncOutbox"\("groupID", "userID"\)/,
    );
    expect(sql).toContain('ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1');
    expect(sql).toContain('ADD COLUMN "processingGeneration" INTEGER');
    expect(sql).toContain(
      'ADD COLUMN "processingOperation" "GroupSyncOperation"',
    );
    expect(sql).toContain('GroupSyncOutbox_processing_state_check');
  });
});
