import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 自动销毁默认值的两处必须同时改，否则改了也没用：
 *
 * - DEFAULT_PRIVACY_SETTINGS：影响**绝大多数**用户 —— getSettings 读到没有行时
 *   不写库，所以从没进过隐私设置的人一直走这份内存默认值，列默认值根本轮不到它
 * - schema / 迁移的列默认值：只影响之后新建的行
 *
 * 只改其中一处会得到一个「看起来改了、实际按用户群分裂成两种行为」的状态，
 * 而这个设置失效时没有任何报错 —— 消息只是安静地翻不到。
 *
 * 存量行刻意不动，见下面那条用例。
 */
describe('message self-destruct default', () => {
  const root = join(__dirname, '../..');
  const migrationPath = join(
    root,
    'prisma/migrations/20260809000000_self_destruct_default_off/migration.sql',
  );

  it('defaults to off in schema, service and the column default migration', () => {
    expect(existsSync(migrationPath)).toBe(true);

    const schema = readFileSync(
      join(root, 'prisma/schema.prisma'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const service = readFileSync(
      join(__dirname, 'privacy-settings.service.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

    expect(schema).toMatch(/messageSelfDestructDays\s+Int\s+@default\(0\)/);
    expect(service).toMatch(/messageSelfDestructDays:\s*0,/);
    expect(sql).toContain(
      'ALTER COLUMN "messageSelfDestructDays" SET DEFAULT 0',
    );
  });

  /**
   * 迁移不得改写任何存量行。
   *
   * 库里分不清「显式选了 2 天」和「建行时吃到旧列默认值」，而这两种代价不对称：
   * 留着，最坏是一部分动过设置的账号继续保留两天窗口，他们随时能自己改；重置，
   * 最坏是把某人主动开启的自毁悄悄关掉 —— 隐私设置只能由用户自己放松，不能被
   * 一条迁移替他放松。
   *
   * 而且真正受影响的那批人库里根本没有行，靠 DEFAULT_PRIVACY_SETTINGS 就全覆盖了，
   * 改存量对修复本身没有任何贡献。
   */
  it('never rewrites existing rows, so an explicit 2-day choice survives', () => {
    const sql = readFileSync(migrationPath, 'utf8')
      .replace(/\r\n/g, '\n')
      // 去掉注释行再断言，避免注释里出现的关键字造成假阴性。
      .replace(/^\s*--.*$/gm, '');

    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bUSING\b/i);
  });

  it('keeps 0 as a selectable option so "off" is reachable from the UI', () => {
    const dto = readFileSync(
      join(__dirname, 'privacy-settings.dto.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(dto).toMatch(/SELF_DESTRUCT_DAY_OPTIONS = \[\s*0\s*,/);
  });
});
