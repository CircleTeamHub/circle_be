import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * 真库回归测试的公共入口。只有显式给了隔离测试库(库名里带 test)时才跑,
 * 每个用例文件在里面建一个自己的 schema,跑完整个删掉 —— 不依赖迁移后的
 * public 表,也不会和别的用例文件抢数据。
 *
 * 用法:建最小表 → 套迁移里的索引/函数 → 用 src 里导出的同一个查询构造器
 * 跑真实 SQL。查询必须从源码里来,手抄一份的话源码改了测试照样绿。
 */
const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
if (
  databaseUrl &&
  (process.env.NODE_ENV !== 'test' ||
    !/test/i.test(new URL(databaseUrl).pathname))
) {
  throw new Error('PostgreSQL regressions require an isolated test database');
}

export const describePostgres = databaseUrl ? describe : describe.skip;

export type IsolatedSchema = {
  db: Client;
  schema: string;
  close: () => Promise<void>;
};

export async function openIsolatedSchema(
  prefix: string,
): Promise<IsolatedSchema> {
  const schema = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}", public`);
  return {
    db,
    schema,
    close: async () => {
      try {
        await db.query('ROLLBACK').catch(() => undefined);
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await db.end();
      }
    },
  };
}

/** EXPLAIN 的 JSON 计划压成字符串,断言「用了哪个索引」用。 */
export async function explainPlan(
  db: Client,
  sql: string,
  values: unknown[] = [],
): Promise<string> {
  const result = await db.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    values,
  );
  return JSON.stringify(result.rows[0]['QUERY PLAN']);
}
