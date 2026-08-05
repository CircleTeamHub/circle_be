import { readFileSync } from 'fs';
import { join } from 'path';

const migrationPath = join(
  process.cwd(),
  'prisma/migrations/20260722010000_restore_group_sync_outbox_idempotency/migration.sql',
);

describe('group sync desired-state migration', () => {
  // Normalize CRLF: Windows checkouts (core.autocrlf=true) rewrite the working
  // tree, and the CTE regexes below anchor on a literal "\n".
  const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

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

  it('chooses desired intent strictly by createdAt and id across all statuses', () => {
    const desiredRanking =
      /WITH ranked_desired AS \(([\s\S]*?)\),\ndesired AS/.exec(sql)?.[1];
    const deletionRanking =
      /WITH ranked AS \(([\s\S]*?)\)\nDELETE FROM "GroupSyncOutbox"/.exec(
        sql,
      )?.[1];

    expect(desiredRanking).toMatch(
      /ORDER BY\s+job\."createdAt" DESC,\s+job\."id" DESC/,
    );
    expect(deletionRanking).toMatch(/ORDER BY\s+"createdAt" DESC,\s+"id" DESC/);
    expect(desiredRanking).not.toContain('"status" IN');
    expect(deletionRanking).not.toContain('"status" IN');
    expect(sql).toContain('PARTITION BY "groupID", "userID"');
    expect(sql).toContain(
      'Independently retain the newest PROCESSING attempt so lease recovery replays',
    );
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
