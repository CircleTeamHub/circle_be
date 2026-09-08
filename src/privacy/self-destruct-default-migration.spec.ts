import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 全局阅后即焚默认值的两处必须同时改，否则改了也没用：
 *
 * - DEFAULT_PRIVACY_SETTINGS：影响**绝大多数**用户 —— getSettings 读到没有行时
 *   不写库，所以从没进过隐私设置的人一直走这份内存默认值，列默认值根本轮不到它
 * - schema / 迁移的列默认值：只影响之后新建的行
 *
 * 只改其中一处会得到一个「看起来改了、实际按用户群分裂成两种行为」的状态，
 * 而这个设置失效时没有任何报错 —— 消息只是安静地翻不到。
 *
 * 存量行由迁移一并归零，见下面那条用例。
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

    // 20260907120000 把这个设置从「天」改存「秒」(与会话级焚毁共用一张档位表)。
    // 默认关闭的语义不变，钉住的列换成新的那一列；旧列还在 schema 里等下一版删除。
    expect(schema).toMatch(/messageSelfDestructSec\s+Int\s+@default\(0\)/);
    expect(service).toMatch(/messageSelfDestructSec:\s*0,/);
    expect(sql).toContain(
      'ALTER COLUMN "messageSelfDestructDays" SET DEFAULT 0',
    );
  });

  /**
   * 存量行全部归零，不带 WHERE —— 产品未上线，所有人从关闭状态起步。
   *
   * 带上 WHERE 会漏掉显式选过 1 / 7 / 30 天的行，那不是这里想要的语义。
   */
  it('resets every existing row, not just the ones holding the old default', () => {
    const sql = readFileSync(migrationPath, 'utf8')
      .replace(/\r\n/g, '\n')
      // 去掉注释行再断言，避免注释里出现的关键字造成假阴性。
      .replace(/^\s*--.*$/gm, '');

    const update = sql.match(/UPDATE "UserPrivacySetting"[^;]*;/i);
    expect(update).not.toBeNull();
    expect(update![0]).toMatch(/SET "messageSelfDestructDays" = 0/);
    expect(update![0]).not.toMatch(/\bWHERE\b/i);
  });

  it('keeps 0 as a selectable option so "off" is reachable from the UI', () => {
    // 档位表已经收敛到 common/burn-durations.ts —— 全局设置和会话级焚毁共用它。
    const choices = readFileSync(
      join(root, 'src/common/burn-durations.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(choices).toMatch(/BURN_DURATION_OFF = 0;/);
    expect(choices).toMatch(/BURN_DURATION_CHOICES = \[\s*BURN_DURATION_OFF,/);
  });
});
