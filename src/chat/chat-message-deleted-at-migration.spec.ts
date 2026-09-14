import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

describe('chat message deletedAt migrations', () => {
  const columnMigration = resolve(
    process.cwd(),
    'prisma/migrations/20260913001000_add_chat_message_deleted_at/migration.sql',
  );
  const indexMigration = resolve(
    process.cwd(),
    'prisma/migrations/20260913001100_index_chat_message_deleted_at/migration.sql',
  );
  const read = (path: string): string =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Repository-owned migration fixtures only.
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  it('keeps the column migration metadata-only', () => {
    const sql = read(columnMigration);

    expect(sql).toMatch(/ADD COLUMN "deletedAt" TIMESTAMP\(3\)/);
    expect(sql).not.toMatch(/UPDATE\s+"ChatMessage"/i);
    expect(sql).not.toMatch(/CREATE\s+INDEX/i);
  });

  it('builds the hot-table index concurrently in a separate migration', () => {
    expect(existsSync(indexMigration)).toBe(true);
    const sql = read(indexMigration);

    expect(sql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_conversationID_deletedAt_idx"/,
    );
    expect(sql).toMatch(/ON "ChatMessage"\("conversationID", "deletedAt"\)/);
  });
});
