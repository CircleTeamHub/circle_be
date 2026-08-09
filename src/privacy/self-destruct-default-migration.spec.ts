import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 自动销毁默认值的三处必须同时改，否则改了也没用：
 *
 * - schema 的列默认值：只影响之后新建的行
 * - DEFAULT_PRIVACY_SETTINGS：影响**绝大多数**用户 —— getSettings 读到没有行时
 *   不写库，所以从没进过隐私设置的人一直走这份内存默认值，列默认值根本轮不到它
 * - 迁移：把存量行里的旧默认值归零，否则老账号继续静默吞历史
 *
 * 只改其中一两处会得到一个「看起来改了、实际按用户群分裂成两种行为」的状态，
 * 而这个设置失效时没有任何报错 —— 消息只是安静地翻不到。
 */
describe('message self-destruct default', () => {
  const root = join(__dirname, '../..');
  const migrationPath = join(
    root,
    'prisma/migrations/20260809000000_self_destruct_default_off/migration.sql',
  );

  it('defaults to off in schema, service and the backfill migration', () => {
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
    // 存量归零：只动旧默认值 2，显式选过 1 / 7 / 30 的行不碰。
    expect(sql).toMatch(
      /UPDATE "UserPrivacySetting" SET "messageSelfDestructDays" = 0 WHERE "messageSelfDestructDays" = 2/,
    );
  });

  it('keeps 0 as a selectable option so "off" is reachable from the UI', () => {
    const dto = readFileSync(
      join(__dirname, 'privacy-settings.dto.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(dto).toMatch(/SELF_DESTRUCT_DAY_OPTIONS = \[\s*0\s*,/);
  });
});
