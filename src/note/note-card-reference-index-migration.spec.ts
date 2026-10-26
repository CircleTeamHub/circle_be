import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { noteCardConversationsQuery } from './note-card-recipients.query';

/**
 * 笔记卡片状态广播要找出「哪些会话里还有指向这些笔记的有效卡片」。原先用 Prisma 的
 * JSON path 过滤，生成 (content#>ARRAY[...])::jsonb = $n，ChatMessage 上没有任何
 * 索引能接住，每次老板改开工/打烊都扫一遍全库最大的表。
 *
 * 部分表达式索引能不能用上，取决于三处一字不差：索引表达式、索引 WHERE、查询本身。
 * 任何一边单独改了，计划会静默退回全表扫描，而功能测试照样全绿 —— 所以这里把三者
 * 钉在一起：谁改查询的键/表达式/字面量条件，就必须回来同步改迁移，反之亦然。
 */
describe('note card reference index migration', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20261025000000_note_card_reference_indexes/migration.sql',
  );
  const read = (path: string): string =>
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const statementsOf = (sql: string): string[] =>
    sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

  const sorted = (values: string[]): string[] =>
    [...values].sort((a, b) => a.localeCompare(b));

  const INDEX_STATEMENT =
    /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_note_card_(\w+)_idx" ON "ChatMessage" \(\("content" ->> '(\w+)'\)\) WHERE "type" = 'note-card' AND "deleted" = false$/;

  it('builds one concurrent partial expression index per card pointer key', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const statements = statementsOf(read(migrationPath));

    // 现行卡片用 sourceNoteId，早于它的老卡片用 noteId 当来源指针。
    expect(statements).toHaveLength(2);
    const keys = statements.map((statement) => {
      const match = INDEX_STATEMENT.exec(statement);
      expect(match).not.toBeNull();
      // 索引名里的键必须就是表达式里的键，免得复制粘贴改漏一处。
      expect(match![1]).toBe(match![2]);
      return match![2];
    });
    expect(sorted(keys)).toEqual(['noteId', 'sourceNoteId']);
  });

  it('stays free of function bodies so Prisma runs each statement outside a transaction', () => {
    const sql = read(migrationPath);
    const statements = statementsOf(sql).join(';\n');

    // CONCURRENTLY 不能在事务块里执行；文件里一旦出现 $$ 函数体或 DO 块，
    // Prisma 会把整份文件包进一个事务，迁移直接报错。
    expect(sql).not.toMatch(/\$\$/);
    expect(statements).not.toMatch(/\bDO\b/);
    expect(statements).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/);
    // 中断的 CONCURRENTLY 会留下 indisvalid = false 的残骸，文件头要写清怎么查。
    expect(sql).toMatch(/indisvalid/);
  });

  it('keeps the recipient query expression and predicate identical to the indexes', () => {
    const statements = statementsOf(read(migrationPath));
    const indexKeys = statements.map(
      (statement) => INDEX_STATEMENT.exec(statement)![2],
    );
    const query = noteCardConversationsQuery(['note-a', 'note-b']);
    const sql = query.sql.replace(/\s+/g, ' ');

    // 部分索引的谓词只认字面量：参数化后规划期看不到值，证明不了蕴含关系。
    expect(sql).toContain(`"type" = 'note-card'`);
    expect(sql).toContain(`"deleted" = false`);
    expect(sql).toContain(`"revokedAt" IS NULL`);
    // 每个索引键都要有一模一样的表达式，查询里也不能多出没有索引的键。
    const queryKeys = [...sql.matchAll(/\("content" ->> '(\w+)'\)/g)].map(
      (match) => match[1],
    );
    expect(sorted(queryKeys)).toEqual(sorted(indexKeys));
    for (const key of indexKeys) {
      expect(sql).toContain(`("content" ->> '${key}') = ANY(?::text[])`);
    }
    // 参数只有 id 数组（每个键一份），type / deleted 没有被参数化。
    expect(query.values).toEqual(indexKeys.map(() => ['note-a', 'note-b']));
  });

  it('routes the note service broadcast through the shared query builder', () => {
    const service = read(resolve(process.cwd(), 'src/note/note.service.ts'));

    expect(service).toMatch(/\$queryRaw[^(]*\(\s*noteCardConversationsQuery\(/);
    // 回到 JSON path 过滤就又是全表扫描。
    expect(service).not.toMatch(/path: \['sourceNoteId'\]/);
    expect(service).not.toMatch(/path: \['noteId'\]/);
  });
});
