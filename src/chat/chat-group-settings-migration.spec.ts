import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 群设置第二批的迁移:六个带默认值的新列 + 两条回填。钉住 migration.sql 与
 * schema.prisma 描述同一份结构,以及两个「隐私」开关的默认方向没被翻回去。
 *
 * 默认方向是这批迁移里最容易写反的一处:DEFAULT true + 一次性 UPDATE 把圈子会话
 * 关掉,在蓝绿窗口里是有洞的 —— 回填跑完之后、老 pod 退役之前,老二进制建出来的
 * 圈子会话仍会拿到 open 默认,而回填不会再跑第二次。所以 DEFAULT 必须是 false,
 * 由回填去把独立群聊打开(漏网的行只会更严,群主自己能开)。
 */
describe('group settings batch-2 migration', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260909000000_add_group_settings_batch2/migration.sql',
  );
  const read = (path: string): string =>
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  const rosterMigrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260911000000_add_group_remark_and_roster_switch/migration.sql',
  );

  it('adds the notice/avatar columns and the four policy booleans with defaults', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = read(migrationPath);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "notice" TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT/);
    for (const column of [
      'memberCanInvite',
      'qrJoinEnabled',
      'membersCanAddFriends',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `ADD COLUMN IF NOT EXISTS "${column}" BOOLEAN NOT NULL DEFAULT true`,
        ),
      );
    }
  });

  it('defaults both privacy switches closed and opens only standalone groups', () => {
    const sql = read(migrationPath);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "membersCanViewProfiles" BOOLEAN NOT NULL DEFAULT false/,
    );
    // DEFAULT 单独再写一次,给已经跑过旧版本迁移体的库纠正回来。
    expect(sql).toMatch(
      /ALTER COLUMN "membersCanViewProfiles" SET DEFAULT false/,
    );
    // 回填只把独立群聊打开;圈子会话什么都不做 —— 默认已经是关。
    expect(sql).toMatch(
      /UPDATE "ChatConversation"\s+SET "membersCanViewProfiles" = true\s+WHERE "circleID" IS NULL/,
    );
    expect(sql).not.toMatch(/SET "membersCanViewProfiles" = false/);
    const sync = read(
      resolve(process.cwd(), 'src/chat/chat-circle-sync.service.ts'),
    );
    expect(sync).toMatch(/membersCanViewProfiles: false/);
  });

  it('keeps the roster closed by default and adds the private remark', () => {
    const sql = read(rosterMigrationPath);
    // 群备注是「我给这个群起的名字、只有我看得见」,写在座位上而不是会话行上 ——
    // 写到会话行就变成全群共享的群名了。
    expect(sql).toMatch(
      /ALTER TABLE "ChatMember"\s+ADD COLUMN IF NOT EXISTS "remark" TEXT/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "membersCanViewRoster" BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(sql).toMatch(
      /ALTER COLUMN "membersCanViewRoster" SET DEFAULT false/,
    );
    expect(sql).toMatch(
      /UPDATE "ChatConversation"\s+SET "membersCanViewRoster" = true\s+WHERE "circleID" IS NULL/,
    );
    expect(sql).not.toMatch(/SET "membersCanViewRoster" = false/);
    const sync = read(
      resolve(process.cwd(), 'src/chat/chat-circle-sync.service.ts'),
    );
    expect(sync).toMatch(/membersCanViewRoster: false/);
  });

  it('opens the two switches explicitly when a standalone group is created', () => {
    // 建群路径不能靠 DB 默认(现在是关的):独立群聊的「微信群」语义必须写进 create。
    const chat = read(resolve(process.cwd(), 'src/chat/chat.service.ts'));
    expect(chat).toMatch(/membersCanViewRoster: true/);
    expect(chat).toMatch(/membersCanViewProfiles: true/);
  });

  it('is expand-only and matches the prisma schema', () => {
    for (const path of [migrationPath, rosterMigrationPath]) {
      const sql = read(path);
      expect(sql).not.toMatch(/DROP (TABLE|COLUMN|TYPE)/i);
      expect(sql).not.toMatch(/RENAME/i);
    }
    const schema = read(resolve(process.cwd(), 'prisma/schema.prisma'));
    expect(schema).toMatch(/notice\s+String\?/);
    expect(schema).toMatch(/memberCanInvite Boolean @default\(true\)/);
    expect(schema).toMatch(/qrJoinEnabled Boolean @default\(true\)/);
    expect(schema).toMatch(/membersCanViewProfiles Boolean @default\(false\)/);
    expect(schema).toMatch(/membersCanAddFriends Boolean @default\(true\)/);
    expect(schema).toMatch(/membersCanViewRoster Boolean @default\(false\)/);
    expect(schema).toMatch(/remark\s+String\?/);
  });
});
