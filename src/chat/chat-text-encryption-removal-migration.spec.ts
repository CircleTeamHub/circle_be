import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 文字加密下线(第二阶段):功能连同 E2ee* 表、textEncryption 列一起删除。
// 触发器和函数不在 Prisma 模型里,migrate diff 看不见 —— 漏删一个,之后每次撤回 /
// 焚毁 / 清空都会因为找不到 "E2eeArchive" 而失败。所以这里不手抄清单,而是从历史
// 迁移里反推加密功能建过的每个触发器和函数,逐一核对本迁移把它们删干净了。
const MIGRATIONS = join(process.cwd(), 'prisma/migrations');
const REMOVAL = '20261026000000_remove_text_encryption';
const ENCRYPTION_TABLES = [
  'E2eeDevice',
  'E2eeKeyPackage',
  'E2eeRoom',
  'E2eeRoomDevice',
  'E2eeEpochEvent',
  'E2eeRecovery',
  'E2eeArchive',
];

const read = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
const withoutComments = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

describe('text encryption removal migration', () => {
  const sql = withoutComments(read(REMOVAL));
  const history = readdirSync(MIGRATIONS)
    .filter(
      (name) =>
        name < REMOVAL && existsSync(join(MIGRATIONS, name, 'migration.sql')),
    )
    .map((name) => withoutComments(read(name)))
    .join('\n');
  const position = (statement: string) => {
    const index = sql.indexOf(statement);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };

  const encryptionFunctions = [
    ...history.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION (\w+)\(\)[^$]*\$\$([\s\S]*?)\$\$/g,
    ),
  ]
    .filter(([, , body]) => body.includes('"E2ee'))
    .map(([, name]) => name);
  const encryptionTriggers = [
    ...history.matchAll(
      /CREATE TRIGGER (\w+)[^;]*?\bON "(\w+)"[^;]*?EXECUTE FUNCTION (\w+)\(/g,
    ),
  ]
    .filter(
      ([, , table, fn]) =>
        ENCRYPTION_TABLES.includes(table) || encryptionFunctions.includes(fn),
    )
    .map(([, name, table, fn]) => ({ name, table, fn }));

  it('finds the encryption triggers and functions in the migration history', () => {
    // 反推本身失灵(正则不再匹配)时,下面的断言会空转通过 —— 先锁住它确实找到了。
    expect(new Set(encryptionFunctions)).toEqual(
      new Set(['purge_e2ee_message_archive', 'purge_e2ee_cleared_archive']),
    );
    expect(new Set(encryptionTriggers.map(({ name }) => name))).toEqual(
      new Set([
        'console_encryption_approve',
        'console_encryption_revoke',
        'e2ee_conversation_retention',
        'e2ee_member_retention',
        'e2ee_message_retention',
      ]),
    );
    expect(encryptionTriggers).toHaveLength(5);
  });

  it('drops every encryption trigger before its function and its table', () => {
    for (const { name, table, fn } of encryptionTriggers) {
      const drop = position(`DROP TRIGGER ${name} ON "${table}";`);
      if (ENCRYPTION_TABLES.includes(table)) {
        expect(drop).toBeLessThan(position(`DROP TABLE "${table}";`));
      }
      if (encryptionFunctions.includes(fn)) {
        expect(drop).toBeLessThan(position(`DROP FUNCTION ${fn}();`));
      }
    }
    for (const fn of new Set(encryptionFunctions)) {
      position(`DROP FUNCTION ${fn}();`);
    }
  });

  it('drops every encryption table and the textEncryption column', () => {
    for (const table of ENCRYPTION_TABLES) {
      position(`DROP TABLE "${table}";`);
    }
    position('ALTER TABLE "ChatConversation" DROP COLUMN "textEncryption";');
  });

  it('keeps the shared console timeline function and the plain burn archive', () => {
    // circle_console_event() 还驱动会话 / 设备 / 钱包 / 订单 / 举报时间线;
    // ChatBurnArchive 是普通阅后即焚的 180 天审计留存,与加密无关。
    expect(sql).not.toMatch(/circle_console_event/);
    expect(sql).not.toMatch(/ChatBurnArchive|archive_burned_chat_message/);
    expect(sql).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE)\b/i);
  });

  // 不含 $$ 的文件会被 Prisma 切成逐条自动提交(docs/migration-baseline.md),中途失败
  // 就留下删了一半的库。末尾的 DO $$ 自检让整份文件退回一个隐式事务,同时在库里
  // 复核没有函数体还引用 E2ee* 表。
  it('runs as one transaction that rejects leftover functions on the dropped tables', () => {
    const selfCheck = sql.indexOf('DO $$');
    expect(selfCheck).toBeGreaterThan(sql.lastIndexOf('DROP '));
    expect(sql.slice(selfCheck)).toMatch(
      /prosrc LIKE '%"E2ee%'[\s\S]*RAISE EXCEPTION[\s\S]*END \$\$;\s*$/,
    );
    expect(sql).not.toMatch(/CONCURRENTLY|\bBEGIN;|\bCOMMIT;/i);
  });

  it('matches a schema with no encryption models left', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).not.toMatch(/\bE2ee\w*/);
    expect(schema).not.toContain('textEncryption');
    expect(schema).toContain('model ChatBurnArchive {');
  });

  // 旧二进制的 Prisma 客户端会读写被删的列和表:必须停机发布,且迁移后不能回滚到旧版。
  it('is released as an irreversible migration that raises the schema floor', () => {
    expect(
      readFileSync(
        join(process.cwd(), 'deploy/REQUIRES_IRREVERSIBLE_MIGRATION'),
        'utf8',
      ),
    ).toContain('20261026000000');
    const compatibility = Number(
      readFileSync(
        join(process.cwd(), 'deploy/SCHEMA_COMPATIBILITY'),
        'utf8',
      ).trim(),
    );
    expect(compatibility).toBeGreaterThanOrEqual(5);
  });
});
