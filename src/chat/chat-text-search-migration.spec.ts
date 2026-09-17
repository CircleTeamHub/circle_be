import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 消息关键词搜索的二元组索引:函数与索引分两个迁移文件,且查询必须与索引的表达式、
 * 部分索引条件逐字对得上,否则规划器不用这个索引 —— 表现是结果完全正确、只是照旧
 * 全表扫,任何功能测试都发现不了。
 */
describe('chat text search migrations', () => {
  const migrationsDir = resolve(process.cwd(), 'prisma/migrations');
  const read = (name: string): string =>
    readFileSync(resolve(migrationsDir, name, 'migration.sql'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
  const withoutComments = (sql: string): string =>
    sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

  const fn = read('20260917000000_add_chat_text_bigrams_function');
  const index = read('20260917000100_add_chat_message_text_bigram_index');
  const service = readFileSync(
    resolve(process.cwd(), 'src/chat/chat.service.ts'),
    'utf8',
  );

  it('creates an immutable function and touches no table in the transactional file', () => {
    // 带 $$ 的文件 Prisma 整份一个事务执行:这里放建索引或改表会锁住 ChatMessage。
    const statements = withoutComments(fn).replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(fn).toMatch(
      /CREATE OR REPLACE FUNCTION chat_text_bigrams\(input text\)/,
    );
    expect(statements).toMatch(/\bIMMUTABLE\b/);
    expect(statements).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(statements).not.toMatch(/ALTER TABLE|UPDATE |INSERT |DELETE /i);
  });

  it('builds the index concurrently from a file Prisma runs statement by statement', () => {
    expect(index).not.toContain('$');
    expect(withoutComments(index)).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_text_bigrams_idx"\nON "ChatMessage" USING gin \(chat_text_bigrams\("content" ->> 'text'\)\)\nWHERE "deleted" = false AND "type" IN \('text', 'quote'\);/,
    );
  });

  it('queries with the same expression and partial-index predicate', () => {
    const lookups = service.match(
      /chat_text_bigrams\(m\."content" ->> 'text'\) @> chat_text_bigrams\(/g,
    );
    // 会话内搜索与全局搜索各一处。
    expect(lookups).toHaveLength(2);
    const predicates = service.match(
      /m\."deleted" = false\s+AND m\."type" IN \('text', 'quote'\)\s+AND chat_text_bigrams/g,
    );
    expect(predicates).toHaveLength(2);
  });
});
