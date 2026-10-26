import { PrismaClient } from 'src/generated/prisma';

/**
 * 让 Prisma 查询「从源码里来」:用一个只记录不执行的假 driver adapter 实例化
 * PrismaClient,把它交给被测 service 跑一次,拿到 Prisma 7 实际编译出的 SQL 和
 * 参数,再到隔离 schema 里 EXPLAIN。源码里的 where/orderBy 改了,这里拿到的 SQL
 * 跟着变 —— 不像手抄一份 SQL 常量那样会和源码脱节。
 *
 * 假 adapter 对每条查询都回空结果集:findMany 得到 [],依赖结果的后续逻辑(count
 * 的结果解析等)可能抛错,调用方吞掉即可,SQL 在抛错前已经记下。
 */
export type CapturedQuery = { sql: string; args: unknown[] };

export function capturePrisma(): {
  prisma: PrismaClient;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const record = (query: { sql: string; args: unknown[] }) => {
    queries.push({
      // 隔离 schema 靠 search_path 解析表名,去掉 Prisma 写死的 "public". 前缀。
      sql: query.sql.replace(/"public"\./g, ''),
      args: query.args,
    });
  };
  const empty = { columnNames: [], columnTypes: [], rows: [] };
  const connection = {
    provider: 'postgres',
    adapterName: 'sql-capture',
    queryRaw(query: { sql: string; args: unknown[] }) {
      record(query);
      return Promise.resolve(empty);
    },
    executeRaw(query: { sql: string; args: unknown[] }) {
      record(query);
      return Promise.resolve(0);
    },
    executeScript() {
      return Promise.resolve();
    },
    startTransaction() {
      return Promise.resolve({
        ...connection,
        options: { usePhantomQuery: false },
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
      });
    },
    dispose() {
      return Promise.resolve();
    },
    getConnectionInfo() {
      return { schemaName: 'public', supportsRelationJoins: false };
    },
  };
  const adapter = {
    provider: 'postgres',
    adapterName: 'sql-capture',
    connect: () => Promise.resolve(connection),
  };
  const prisma = new PrismaClient({
    adapter: adapter as unknown as ConstructorParameters<
      typeof PrismaClient
    >[0]['adapter'],
  });
  return { prisma, queries };
}

/** 跑一次被测调用,吞掉假结果集引起的解析错误,返回期间编译出的全部 SQL。 */
export async function captureQueries(
  queries: CapturedQuery[],
  run: () => Promise<unknown>,
): Promise<CapturedQuery[]> {
  queries.length = 0;
  await run().catch(() => undefined);
  return [...queries];
}
