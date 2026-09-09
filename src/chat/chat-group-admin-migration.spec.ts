import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 群管理 + 群日志的迁移是纯 expand(新枚举、带默认值的新列、新表)。
 * 这组断言钉住两件事:migration.sql 与 schema.prisma 描述的是同一份结构
 * (否则 migrate diff 会在部署时才炸),以及它没有偷偷长出破坏兼容的语句。
 */
describe('group admin and event log migration', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260908000000_add_group_admin_and_event_log/migration.sql',
  );
  const read = (path: string): string =>
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  it('adds the standalone role and silence columns with defaults', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = read(migrationPath);
    expect(sql).toMatch(
      /CREATE TYPE "ChatMemberRole" AS ENUM \('MEMBER', 'ADMIN'\)/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "role" "ChatMemberRole" NOT NULL DEFAULT 'MEMBER'/,
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "silencedAt" TIMESTAMP\(3\)/);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "silencedUntil" TIMESTAMP\(3\)/,
    );
  });

  it('creates the event table with the keyset index the reader paginates on', () => {
    const sql = read(migrationPath);
    expect(sql).toMatch(/CREATE TABLE "ChatGroupEvent"/);
    expect(sql).toMatch(/"targetIDs"\s+TEXT\[\]/);
    expect(sql).toMatch(
      /CREATE INDEX "ChatGroupEvent_conversationID_createdAt_id_idx"\s+ON "ChatGroupEvent"\("conversationID", "createdAt", "id"\)/,
    );
    expect(sql).toMatch(/ON DELETE CASCADE/);
  });

  it('is expand-only: no drops, renames or type changes', () => {
    const sql = read(migrationPath);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|TYPE)/i);
    expect(sql).not.toMatch(/RENAME/i);
    expect(sql).not.toMatch(/ALTER COLUMN .* TYPE/i);
  });

  it('matches the prisma schema', () => {
    const schema = read(resolve(process.cwd(), 'prisma/schema.prisma'));
    expect(schema).toMatch(/enum ChatMemberRole \{\s*MEMBER\s*ADMIN\s*\}/);
    expect(schema).toMatch(/role\s+ChatMemberRole @default\(MEMBER\)/);
    expect(schema).toMatch(/silencedAt\s+DateTime\?/);
    expect(schema).toMatch(/silencedUntil\s+DateTime\?/);
    expect(schema).toMatch(/model ChatGroupEvent \{/);
    expect(schema).toMatch(/targetIDs\s+String\[\] @default\(\[\]\)/);
    expect(schema).toMatch(/@@index\(\[conversationID, createdAt, id\]\)/);
  });
});
