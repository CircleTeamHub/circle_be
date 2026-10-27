import { PrismaPg } from '@prisma/adapter-pg';
import { prismaSchemaDdl } from './prisma-schema-ddl';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from 'src/generated/prisma';
import { openIsolatedSchema, type IsolatedSchema } from './pg-test-db';

/**
 * 让被测 service 带着**真的** PrismaClient 跑在隔离 schema 里。
 *
 * 表结构不手抄:用 `prisma migrate diff --from-empty --to-schema` 从
 * schema.prisma 现场生成整份 DDL(表/枚举/索引/外键,不含迁移里手写的触发器),
 * Prisma 改了模型这里跟着变。PrismaPg 的 `schema` 选项让生成的 SQL 落到隔离 schema。
 *
 * 每个 client 自带一个 pg 池(application_name = schema 名),池上挂了两件观测工具:
 * - statements:真正发到 Postgres 的每条语句(含 BEGIN/COMMIT/SAVEPOINT),
 *   断言一次调用的往返次数;
 * - maxCheckedOut:观测期间同时被借出的连接数峰值。
 */
const prismaDdl = prismaSchemaDdl;

export type Observation = {
  statements: string[];
  /** 同一批语句带上绑定参数,拿去 EXPLAIN 用。 */
  calls: Array<{ text: string; values: unknown[] }>;
  maxCheckedOut: () => number;
  stop: () => void;
};

export type PrismaHandle = {
  prisma: PrismaClient;
  pool: Pool;
  /** 从现在起记录语句与连接峰值,直到 stop()。 */
  observe: () => Observation;
};

export type PrismaSchemaDb = IsolatedSchema & {
  /** 在这个 schema 上再开一个独立的池 + PrismaClient。 */
  client: (poolMax: number) => PrismaHandle;
};

function statementCall(args: unknown[]): { text: string; values: unknown[] } {
  const [first, second] = args;
  if (typeof first === 'string')
    return { text: first, values: Array.isArray(second) ? second : [] };
  if (first && typeof first === 'object' && 'text' in first) {
    const config = first as { text: unknown; values?: unknown };
    return {
      text: String(config.text),
      values: Array.isArray(config.values) ? config.values : [],
    };
  }
  return { text: '<unknown>', values: [] };
}

function observedClient(schema: string, poolMax: number): PrismaHandle {
  const pool = new Pool({
    connectionString: process.env.POSTGRES_TEST_DATABASE_URL,
    max: poolMax,
    options: `-c search_path=${schema},public`,
    // 用 schema 名当 application_name:并发用例在 pg_stat_activity 里只认自己的连接。
    application_name: schema,
  });
  let recording: Observation | null = null;
  let checkedOut = 0;
  let peak = 0;
  const wrapped = new WeakSet<PoolClient>();
  pool.on('acquire', (client) => {
    checkedOut += 1;
    peak = Math.max(peak, checkedOut);
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      if (recording) {
        const call = statementCall(args);
        recording.statements.push(call.text);
        recording.calls.push(call);
      }
      return original(...args);
    };
  });
  pool.on('release', () => {
    checkedOut -= 1;
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema }),
  });
  return {
    prisma,
    pool,
    observe: () => {
      const observation: Observation = {
        statements: [],
        calls: [],
        maxCheckedOut: () => peak,
        stop: () => {
          if (recording === observation) recording = null;
        },
      };
      recording = observation;
      peak = checkedOut;
      return observation;
    },
  };
}

export async function openPrismaSchema(
  prefix: string,
): Promise<PrismaSchemaDb> {
  const isolated = await openIsolatedSchema(prefix);
  await isolated.db.query(prismaDdl());
  const handles: PrismaHandle[] = [];
  return {
    ...isolated,
    client: (poolMax) => {
      const handle = observedClient(isolated.schema, poolMax);
      handles.push(handle);
      return handle;
    },
    close: async () => {
      for (const handle of handles) {
        await handle.prisma.$disconnect().catch(() => undefined);
        await handle.pool.end().catch(() => undefined);
      }
      await isolated.close();
    },
  };
}
