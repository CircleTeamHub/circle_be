import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 来电推送靠 DevicePushToken 上的两列筛设备、选 APNs 环境。schema 与迁移只改一边，
 * Prisma client 会照着 schema 生成、生产库却没有这两列 —— 第一通电话就 500。
 */
describe('call push token columns', () => {
  const root = join(__dirname, '../..');
  const read = (path: string) =>
    readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

  it('declares the same nullable columns in schema and migration', () => {
    const schema = read('prisma/schema.prisma');
    const model = schema.slice(
      schema.indexOf('model DevicePushToken {'),
      schema.indexOf('}', schema.indexOf('model DevicePushToken {')),
    );
    const sql = read(
      'prisma/migrations/20261026120000_call_push_tokens/migration.sql',
    );

    expect(model).toMatch(/\n\s+callPushVersion\s+Int\?\n/);
    expect(model).toMatch(/\n\s+apnsEnvironment\s+String\?\n/);
    expect(sql).toContain(
      'ALTER TABLE "DevicePushToken" ADD COLUMN "callPushVersion" INTEGER;',
    );
    expect(sql).toContain(
      'ALTER TABLE "DevicePushToken" ADD COLUMN "apnsEnvironment" TEXT;',
    );
    // 无默认值的可空列：只改目录，不重写这张热表；旧客户端的行自然是 null。
    expect(sql).not.toMatch(/DEFAULT|NOT NULL/i);
  });
});
