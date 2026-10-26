import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { pageCursor } from './console-operations.service';

/**
 * 发消息/续签是全站最热的两条写入路径,运营台事件触发器就挂在它们的事务里。
 * 这里钉住新迁移的几条硬约束:不再 to_jsonb 整行(消息密文不进触发器)、
 * 发消息按桶 ON CONFLICT 合并、触发器名不变(原地替换而不是多挂一个)、
 * 通用函数 circle_console_event 不动(其余触发器还在用)。
 * 行为本身由 test/postgres/console-event-volume.pg-spec.ts 在真库里验证。
 */
describe('console event volume migration', () => {
  // 一份迁移只换一张表的触发器(见下方用例),消息和会话各一份。
  const MIGRATIONS = [
    '20261025000100_console_message_event',
    '20261025000150_console_session_event',
  ];
  const pathOf = (name: string): string =>
    resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql');
  const readOne = (name: string): string =>
    readFileSync(pathOf(name), 'utf8').replace(/\r\n/g, '\n');
  const read = (): string => MIGRATIONS.map(readOne).join('\n');
  const FUNCTIONS = {
    circle_console_message_event:
      /CREATE OR REPLACE FUNCTION circle_console_message_event\(\)[\s\S]*?END \$\$;/,
    circle_console_session_event:
      /CREATE OR REPLACE FUNCTION circle_console_session_event\(\)[\s\S]*?END \$\$;/,
  };
  const functionBody = (sql: string, name: keyof typeof FUNCTIONS): string => {
    const match = FUNCTIONS[name].exec(sql);
    if (!match) throw new Error(`${name} not found`);
    return match[0];
  };

  it('runs inside the single migration transaction', () => {
    for (const name of MIGRATIONS) expect(existsSync(pathOf(name))).toBe(true);
    // 函数体里有 $$,Prisma 整份一个事务执行;CONCURRENTLY 在事务里直接报错。
    expect(read()).not.toMatch(/CONCURRENTLY/i);
  });

  it('replaces one table’s trigger per migration so a lock wait never holds another table', () => {
    // 含函数体的迁移整份一个事务:两张表写在一起,就会占着前一张表的
    // ShareRowExclusive 锁去等后一张,最坏停写时间翻倍。
    for (const name of MIGRATIONS) {
      const sql = readOne(name);
      const tables = new Set(
        [
          ...sql.matchAll(
            /CREATE OR REPLACE TRIGGER \w+ AFTER \w+ ON "(\w+)"/g,
          ),
        ].map((match) => match[1]),
      );
      expect({ name, tables: tables.size }).toEqual({ name, tables: 1 });
      expect(sql).toMatch(/SET lock_timeout = '5s';[\s\S]*RESET lock_timeout;/);
      expect(sql).toContain(`migrate resolve --rolled-back ${name}`);
    }
  });

  it('collapses messages per sender per 5-minute bucket without reading the whole row', () => {
    const body = functionBody(read(), 'circle_console_message_event');
    expect(body).not.toMatch(/to_jsonb/);
    expect(body).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(body).toMatch(/extract\(epoch FROM NEW\."createdAt"\) \/ 300/);
    // senderID 没有外键,访客发言不能撞 ConsoleEvent 的 userID 外键。
    expect(body).toMatch(
      /EXISTS \(SELECT 1 FROM "User" WHERE id = NEW\."senderID"\)/,
    );
    // 桶键要哈希成 64 位 hex,否则这条事件落在页尾时分页游标无效。
    expect(body).toMatch(/encode\(sha256\(/);
    expect(() =>
      pageCursor(`2026-10-25T12:00:00.000Z|${'a'.repeat(64)}`),
    ).not.toThrow();
  });

  it('records a session only for the first row of a token family', () => {
    const body = functionBody(read(), 'circle_console_session_event');
    expect(body).not.toMatch(/to_jsonb/);
    expect(body).toMatch(
      /NOT EXISTS \(SELECT 1 FROM "RefreshToken" r WHERE r\."userId" = NEW\."userId" AND r\."familyId" = NEW\."familyId" AND r\.id <> NEW\.id\)/,
    );
  });

  it('replaces the two triggers in place and leaves the shared function alone', () => {
    const sql = read();
    expect(sql).toContain(
      'CREATE OR REPLACE TRIGGER console_message AFTER INSERT ON "ChatMessage" FOR EACH ROW WHEN (NEW."senderID" IS NOT NULL) EXECUTE FUNCTION circle_console_message_event();',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE TRIGGER console_session AFTER INSERT ON "RefreshToken" FOR EACH ROW EXECUTE FUNCTION circle_console_session_event();',
    );
    expect(sql.match(/CREATE (OR REPLACE )?TRIGGER/g)).toHaveLength(2);
    expect(sql).not.toMatch(/FUNCTION circle_console_event\(/);
  });

  it('keeps the rotation path reusing the family it rotates', () => {
    // 会话触发器的语义建立在这一点上:续签沿用旧 familyId,新登录换新的。
    const source = readFileSync(
      resolve(process.cwd(), 'src/auth/refresh-token.service.ts'),
      'utf8',
    );
    expect(source).toMatch(/familyId: string = randomUUID\(\)/);
    expect(source).toMatch(/record\.audience,\s*record\.familyId,\s*\)/);
  });
});
