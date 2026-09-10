import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 群设置第二批的迁移:六个带默认值的新列 + 一条回填。钉住 migration.sql 与
 * schema.prisma 描述同一份结构,以及「圈子会话默认不放开成员资料」这条回填没丢
 * (丢了等于把 review R2 的圈子隐私设计静默放宽)。
 */
describe('group settings batch-2 migration', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260909000000_add_group_settings_batch2/migration.sql',
  );
  const read = (path: string): string =>
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  it('adds the notice/avatar columns and the four policy booleans with defaults', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = read(migrationPath);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "notice" TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT/);
    for (const column of [
      'memberCanInvite',
      'qrJoinEnabled',
      'membersCanViewProfiles',
      'membersCanAddFriends',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `ADD COLUMN IF NOT EXISTS "${column}" BOOLEAN NOT NULL DEFAULT true`,
        ),
      );
    }
  });

  it('keeps circle conversations private by default', () => {
    const sql = read(migrationPath);
    expect(sql).toMatch(
      /UPDATE "ChatConversation"\s+SET "membersCanViewProfiles" = false\s+WHERE "circleID" IS NOT NULL/,
    );
    const sync = read(
      resolve(process.cwd(), 'src/chat/chat-circle-sync.service.ts'),
    );
    expect(sync).toMatch(/membersCanViewProfiles: false/);
  });

  it('keeps the roster closed on existing circle groups and adds the private remark', () => {
    const sql = read(
      resolve(
        process.cwd(),
        'prisma/migrations/20260911000000_add_group_remark_and_roster_switch/migration.sql',
      ),
    );
    // 群备注是「我给这个群起的名字、只有我看得见」,写在座位上而不是会话行上 ——
    // 写到会话行就变成全群共享的群名了。
    expect(sql).toMatch(
      /ALTER TABLE "ChatMember"\s+ADD COLUMN IF NOT EXISTS "remark" TEXT/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "membersCanViewRoster" BOOLEAN NOT NULL DEFAULT true/,
    );
    // 圈子群的成员目录此前是硬门槛,不回填就等于这次上线把它对全员放开。
    expect(sql).toMatch(
      /UPDATE "ChatConversation"\s+SET "membersCanViewRoster" = false\s+WHERE "circleID" IS NOT NULL/,
    );
    const sync = read(
      resolve(process.cwd(), 'src/chat/chat-circle-sync.service.ts'),
    );
    expect(sync).toMatch(/membersCanViewRoster: false/);
  });

  it('is expand-only and matches the prisma schema', () => {
    const sql = read(migrationPath);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|TYPE)/i);
    expect(sql).not.toMatch(/RENAME/i);
    const schema = read(resolve(process.cwd(), 'prisma/schema.prisma'));
    expect(schema).toMatch(/notice\s+String\?/);
    expect(schema).toMatch(/memberCanInvite Boolean @default\(true\)/);
    expect(schema).toMatch(/qrJoinEnabled Boolean @default\(true\)/);
    expect(schema).toMatch(/membersCanViewProfiles Boolean @default\(true\)/);
    expect(schema).toMatch(/membersCanAddFriends Boolean @default\(true\)/);
    expect(schema).toMatch(/membersCanViewRoster Boolean @default\(true\)/);
    expect(schema).toMatch(/remark\s+String\?/);
  });
});
