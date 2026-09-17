import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 会话变更序号流的迁移是按「蓝绿发布、旧色照常写入」拆的三个文件,
 * 每一条断言都对应一种一改就会停聊天的写法(见 docs/migration-baseline.md
 * 「迁移文件是不是一个事务」):
 *
 * - prisma migrate deploy 对含 $$ 函数体的文件整份一个事务执行,锁持有到文件结束 ——
 *   这种文件里再放全表 UPDATE 或普通建索引,ChatMessage 就停多久;
 * - 分批回填靠过程里 COMMIT,只有在不含 $ 的文件里 CALL 才允许;
 * - CONCURRENTLY 同样只能出现在 Prisma 逐条执行的文件里。
 */
describe('chat revision stream migrations', () => {
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
  const withoutFunctionBodies = (sql: string): string =>
    withoutComments(sql).replace(/\$\$[\s\S]*?\$\$/g, '$$ … $$');

  const setup = read('20260916000000_add_chat_revision_stream');
  const backfill = read('20260916000100_backfill_chat_message_revision');
  const index = read('20260916000200_add_chat_message_revision_index');

  it('keeps the single-transaction migration to instant DDL', () => {
    const statements = withoutFunctionBodies(setup);
    // 函数体之外只允许加列、建函数/过程、建触发器(触发器定义里的
    // 「BEFORE INSERT OR UPDATE」不是语句,所以只看行首)。
    const dml = statements
      .split('\n')
      .map((line) => line.trimStart().toUpperCase())
      .filter((line) =>
        ['UPDATE ', 'INSERT ', 'DELETE '].some((keyword) =>
          line.startsWith(keyword),
        ),
      );
    expect(dml).toEqual([]);
    expect(statements).not.toMatch(/CREATE INDEX/i);
    expect(statements).not.toMatch(/CREATE UNIQUE INDEX/i);
    expect(statements).not.toMatch(/DROP INDEX/i);
    expect(statements).toMatch(
      /ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "revision"/,
    );
  });

  it('allocates revisions above every backfilled height, in both triggers', () => {
    // 存量回填成 revision = height、会话计数器不整表初始化:取号必须越过 nextHeight,
    // 否则触发器先于回填生效的那段时间里,新号会撞上存量号。
    const allocations = setup.match(
      /SET "nextRevision" = GREATEST\("nextRevision", "nextHeight"\) \+ 1/g,
    );
    expect(allocations).toHaveLength(2);
    expect(setup).not.toMatch(/"nextRevision" = "nextRevision" \+ 1/);
  });

  it('backfills in committed batches from a file Prisma runs statement by statement', () => {
    const procedure = setup.slice(
      setup.indexOf(
        'CREATE OR REPLACE PROCEDURE chat_message_backfill_revision',
      ),
    );
    expect(procedure).toMatch(/COMMIT;/);
    // 触发器生效后被撤回/编辑/回应过的存量消息已经有新号,回填不能把它们盖回 height。
    expect(procedure).toMatch(/"revision" = 0/);

    expect(backfill).not.toContain('$');
    expect(withoutComments(backfill)).toMatch(
      /^CALL chat_message_backfill_revision\(\d+\);\nDROP PROCEDURE IF EXISTS chat_message_backfill_revision\(integer\);\s*$/m,
    );
  });

  it('builds the sync index concurrently after the backfill', () => {
    expect(index).not.toContain('$');
    expect(withoutComments(index).trim()).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_conversationID_revision_idx"\nON "ChatMessage"("conversationID", "revision");',
    );
  });

  it('keeps the legacy mutation-channel indexes for the rollback binary', () => {
    const schema = readFileSync(
      resolve(process.cwd(), 'prisma/schema.prisma'),
      'utf8',
    );
    for (const column of ['revokedAt', 'editedAt', 'deletedAt']) {
      expect(schema).toContain(`@@index([conversationID, ${column}])`);
    }
    const revisionStreamMigrations = readdirSync(migrationsDir).filter((name) =>
      name.startsWith('202609160'),
    );
    for (const name of revisionStreamMigrations) {
      expect(withoutComments(read(name))).not.toMatch(/DROP INDEX/i);
    }
  });

  it('reads the conversation watermark, never the raw counter', () => {
    const service = readFileSync(
      resolve(process.cwd(), 'src/chat/chat.service.ts'),
      'utf8',
    );
    expect(service).not.toMatch(/syncRevision: [\w.]+\.nextRevision/);
    expect(service).not.toMatch(/throughRevision = [\w.]+\.nextRevision/);
    expect(
      service.match(/conversationSyncRevision\(/g)?.length,
    ).toBeGreaterThanOrEqual(5);
  });
});
