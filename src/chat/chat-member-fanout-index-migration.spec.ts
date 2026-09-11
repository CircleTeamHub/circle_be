import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 消息扇出的收件人查询没有能覆盖它的索引：ChatMember 上只有
 * (conversationID, userID) 唯一索引和 (userID) 索引，于是 leftAt 与
 * clearedBeforeHeight 两个条件只能逐行回表。3000 人的圈子群里，每条消息要付
 * 两次全量回表 —— 广播一次、推送一次。
 *
 * 这条断言钉的是「索引和用它的查询必须一起改」：谁改了扇出查询的过滤列或
 * select 列，就必须回来把索引一起改，否则 index-only scan 会静默退化成回表，
 * 而这种退化在测试里没有任何别的信号。
 */
describe('chat member fanout index migration', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260906010000_add_chat_member_fanout_index/migration.sql',
  );
  const read = (path: string): string =>
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  it('creates a covering index in the order the fanout query filters', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = read(migrationPath);

    expect(sql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_fanout_idx"/,
    );
    // 顺序即语义：等值(conversationID) -> NULL 条件(leftAt) -> 范围
    // (clearedBeforeHeight)，范围列之后的列不能再当索引条件用，所以两个
    // 覆盖列必须排在最后。
    expect(sql).toMatch(
      /ON "ChatMember"\("conversationID", "leftAt", "clearedBeforeHeight", "userID", "muted"\)/,
    );
  });

  it('declares the same index in the schema so migrate diff stays clean', () => {
    const schema = read(resolve(process.cwd(), 'prisma/schema.prisma'));

    expect(schema).toMatch(
      /@@index\(\[conversationID, leftAt, clearedBeforeHeight, userID, muted\], map: "ChatMember_fanout_idx"\)/,
    );
  });

  it('keeps the broadcast and push recipient queries inside what the index covers', () => {
    const broadcast = read(
      resolve(process.cwd(), 'src/chat/chat-broadcast.service.ts'),
    );
    const push = read(resolve(process.cwd(), 'src/chat/chat-push.service.ts'));

    for (const source of [broadcast, push]) {
      expect(source).toMatch(/conversationID: /);
      expect(source).toMatch(/leftAt: null/);
      expect(source).toMatch(/clearedBeforeHeight: \{ lt: /);
    }
    // 广播只取 userID，推送再要一个 muted —— 两者都在索引尾部。
    expect(broadcast).toMatch(/select: \{ userID: true \}/);
    expect(push).toMatch(/select: \{ userID: true, muted: true \}/);
  });
});
