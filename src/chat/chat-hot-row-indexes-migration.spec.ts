import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 发送一条消息的事务里(会话行 FOR UPDATE 期间)有两处与群规模、索引数量成正比的
 * 写开销,这个迁移各补一刀:
 *
 * 1. 「新消息让隐藏的会话重新浮出」的 updateMany 按 (conversationID, hiddenAt IS NOT
 *    NULL) 过滤,原有索引都不含 hiddenAt —— 3000 人的群每条消息回表 3000 次,而绝大
 *    多数时候一行都不匹配。部分索引只收当前隐藏着的座位,平时几乎是空的。
 * 2. 会话行每条消息都要 UPDATE(lastMessageAt 在索引里,永远不是 HOT),非 HOT 更新要给
 *    该行的每个索引写新条目 —— 包括 id / circleID 上的 trigram GIN。管理台的两处会话
 *    搜索(OR 里带子查询或 COALESCE)本来就用不上它们,UUID 子串搜索也没有业务价值。
 *
 * 第 2 点的两条 DROP 各在 20261025000300 / 20261025000400 里。
 *
 * 断言钉的是「索引和用它的查询必须一起改」:谁改了 updateMany 的过滤条件,部分索引
 * 就会静默失效,而这种退化在别的测试里没有任何信号。
 */
describe('chat hot-row indexes migration', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20261025000200_chat_hot_row_indexes/migration.sql',
  );
  const read = (path: string): string =>
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  it('adds a partial index holding only currently hidden seats', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = read(migrationPath);

    expect(sql).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_hidden_conversation_idx"\s+ON "ChatMember" \("conversationID"\)\s+WHERE "hiddenAt" IS NOT NULL;/,
    );
  });

  it('drops each UUID trigram index in its own migration and keeps the name one', () => {
    // 一份迁移只放一条 DROP INDEX CONCURRENTLY:和别的语句混写时 Prisma 会整份
    // 放进一个事务,部署报 25001(规则见 src/prisma/concurrent-index-migrations.spec.ts)。
    const drops = {
      '20261025000300_drop_conversation_id_trgm':
        'ChatConversation_id_trgm_idx',
      '20261025000400_drop_conversation_circle_trgm':
        'ChatConversation_circleID_trgm_idx',
    };
    for (const [migration, index] of Object.entries(drops)) {
      const statements = read(
        resolve(process.cwd(), 'prisma/migrations', migration, 'migration.sql'),
      )
        .replace(/--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      expect(statements).toEqual([
        `DROP INDEX CONCURRENTLY IF EXISTS "${index}"`,
      ]);
    }
    expect(read(migrationPath).replace(/--.*$/gm, '')).not.toMatch(
      /DROP INDEX/,
    );
    expect(read(migrationPath)).not.toContain('ChatConversation_name_trgm_idx');
  });

  it('removes the dropped indexes from the schema so migrate diff stays clean', () => {
    const schema = read(resolve(process.cwd(), 'prisma/schema.prisma'));

    expect(schema).not.toContain('ChatConversation_id_trgm_idx');
    expect(schema).not.toContain('ChatConversation_circleID_trgm_idx');
    expect(schema).toContain('ChatConversation_name_trgm_idx');
  });

  it('keeps every send-path resurface update inside the partial index predicate', () => {
    // 发送、系统消息、自动回复都会让隐藏的会话浮出,三处的过滤条件必须保持
    // (conversationID 等值 + hiddenAt IS NOT NULL),部分索引才用得上。
    const files = [
      'src/chat/chat.service.ts',
      'src/chat/chat-system-message.service.ts',
      'src/chat/chat-direct-auto-reply.processor.ts',
    ];
    const resurface =
      /chatMember\.updateMany\(\{\s*where:\s*\{\s*conversationID:[^}]*?,\s*hiddenAt:\s*\{\s*not:\s*null\s*\},?\s*\},\s*data:\s*\{\s*hiddenAt:\s*null\s*\}/g;
    for (const file of files) {
      const hits = read(resolve(process.cwd(), file)).match(resurface);
      expect(`${file}: ${hits?.length ?? 0}`).not.toBe(`${file}: 0`);
    }
  });
});
