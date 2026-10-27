import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * PostgreSQL 不允许 CONCURRENTLY 出现在多语句查询里(隐式事务块,报 25001),所以
 * 迁移里的 CONCURRENTLY 能不能部署,取决于 Prisma 会不会把文件拆成单条执行。
 * 实测(Prisma 7.9.1 + PostgreSQL 16,从空库 migrate deploy):
 * - 多条 CREATE INDEX CONCURRENTLY、再混一条 CREATE EXTENSION —— 逐条执行,没问题;
 * - 文件里有 DROP INDEX CONCURRENTLY 且多于一条语句(和 CREATE 混写、或两条 DROP)
 *   —— 整份当一个脚本发,部署失败。20261025000200 起初就是这样挂的;
 * - 有函数体($$)/DO 块的文件整份进一个事务(仓库既有约定)。
 *
 * 规则:DROP INDEX CONCURRENTLY 一份迁移只放一条;含 CONCURRENTLY 的迁移不写函数体/DO 块。
 */
const MIGRATIONS = resolve(process.cwd(), 'prisma/migrations');

const statements = (sql: string): string[] =>
  sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describe('concurrent index migrations', () => {
  const migrations = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      // 注释里常会提到 DROP INDEX CONCURRENTLY(恢复步骤),只看语句本身。
      sql: readFileSync(
        join(MIGRATIONS, entry.name, 'migration.sql'),
        'utf8',
      ).replace(/--.*$/gm, ''),
    }));

  it('keeps every DROP INDEX CONCURRENTLY alone in its migration', () => {
    const offenders = migrations
      .filter(({ sql }) => /\bDROP\s+INDEX\s+CONCURRENTLY\b/i.test(sql))
      .filter(({ sql }) => statements(sql).length !== 1)
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('keeps function bodies and DO blocks out of CONCURRENTLY migrations', () => {
    const offenders = migrations
      .filter(({ sql }) => /\bCONCURRENTLY\b/i.test(sql))
      .filter(({ sql }) => /\$\$|^\s*DO\b/im.test(sql))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
