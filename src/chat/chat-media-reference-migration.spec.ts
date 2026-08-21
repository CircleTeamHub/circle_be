import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

describe('chat media reference migration', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260820190000_chat_media_references/migration.sql',
  );

  it('creates and backfills active note-import message references', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    expect(sql).toMatch(/CREATE TABLE "ChatMediaReference"/);
    expect(sql).toMatch(/content->>'key'/);
    expect(sql).toMatch(/content->>'thumbKey'/);
    expect(sql).toMatch(/"deleted" = false/);
    expect(sql).toMatch(/"revokedAt" IS NULL/);
    expect(sql).toMatch(/note-import/);
  });
});
