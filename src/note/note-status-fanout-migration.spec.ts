import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 笔记来源状态 outbox 那批迁移的形状。加列要拿 ACCESS EXCLUSIVE,回填要扫整张表:
 * 两件事放进同一个事务,这把锁就会一直持有到回填扫完,Note / ChatMessage 的读写
 * 全部排队。这里钉住:加列每份只碰一张表并带 lock_timeout,回填单独提交、只拿行锁,
 * 顺序是 加列 → 回填 Note 根 → 回填卡片(依赖 Note 根)→ 并发建索引。
 * 回填结果本身由 migrate deploy 在真库上跑出来。
 */
describe('note status fan-out migrations', () => {
  const ADD_COLUMNS = [
    ['20261020000000_add_note_status_fanout_outbox', 'Note'],
    ['20261020000010_add_chat_message_source_note_id', 'ChatMessage'],
  ] as const;
  const BACKFILLS = [
    ['20261020000020_backfill_note_root_source', 'Note'],
    ['20261020000030_backfill_chat_message_source_note', 'ChatMessage'],
  ] as const;
  const INDEXES = '20261020000100_index_note_status_fanout';

  const pathOf = (name: string): string =>
    resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql');
  /** 去掉注释行,只看真正执行的 SQL。 */
  const sqlOf = (name: string): string =>
    readFileSync(pathOf(name), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
  const tablesMatching = (sql: string, pattern: RegExp): Set<string> =>
    new Set([...sql.matchAll(pattern)].map((match) => match[1]));

  it('exists as separate migrations', () => {
    for (const [name] of [...ADD_COLUMNS, ...BACKFILLS]) {
      expect(existsSync(pathOf(name))).toBe(true);
    }
    expect(existsSync(pathOf(INDEXES))).toBe(true);
  });

  it.each(ADD_COLUMNS)(
    '%s adds a column to %s alone, under a lock timeout, without a backfill',
    (name, table) => {
      const sql = sqlOf(name);
      expect(tablesMatching(sql, /ALTER TABLE "(\w+)"/g)).toEqual(
        new Set([table]),
      );
      expect(sql).toMatch(
        /SET lock_timeout = '5s';[\s\S]*ALTER TABLE[\s\S]*RESET lock_timeout;/,
      );
      expect(sql).not.toMatch(/\bUPDATE\b/);
      // 等锁超时会留下失败记录,注释里要写清怎么恢复。
      expect(readFileSync(pathOf(name), 'utf8')).toContain(
        `migrate resolve --rolled-back ${name}`,
      );
    },
  );

  it.each(BACKFILLS)(
    '%s backfills %s in its own transaction without taking a table lock',
    (name, table) => {
      const sql = sqlOf(name);
      expect(tablesMatching(sql, /UPDATE "(\w+)"/g)).toEqual(new Set([table]));
      expect(sql).not.toMatch(/ALTER TABLE|CONCURRENTLY|LOCK TABLE/);
    },
  );

  it('orders columns before backfills, note roots before cards, indexes last', () => {
    const names = [
      ...ADD_COLUMNS.map(([name]) => name),
      ...BACKFILLS.map(([name]) => name),
      INDEXES,
    ];
    expect([...names].sort()).toEqual(names);
    // 卡片回填按 Note 根解析老卡片的 noteId,必须读到已回填的 rootSourceNoteID。
    expect(sqlOf(BACKFILLS[1][0])).toContain('"rootSourceNoteID"');
  });
});
