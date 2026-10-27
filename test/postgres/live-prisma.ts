import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { prismaSchemaDdl } from './prisma-schema-ddl';
import { Client, Pool } from 'pg';
import { PrismaClient } from 'src/generated/prisma';
import { openIsolatedSchema, type IsolatedSchema } from './pg-test-db';

/**
 * 真 PrismaClient + 真 PostgreSQL 的回归入口:把被测 service 原样跑在隔离 schema 上。
 *
 * prisma-sql-capture 只能拿到「编译出的 SQL」,依赖结果的分支走不进去;锁与事务形状
 * (临界区里几条语句、谁在等谁)只有真跑才看得见。这里:
 * - 表结构从 prisma/schema.prisma 现场生成(`prisma migrate diff --from-empty`),
 *   schema 改了这里跟着变,不手抄 DDL;迁移里的触发器 / 部分索引按需再套;
 * - adapter 包一层记录器,按连接/事务记下每条语句(含 BEGIN/COMMIT),
 *   断言「锁之后、提交之前跑了哪些语句」;
 * - 原生 SQL 不带 schema 前缀,靠连接的 search_path 落到隔离 schema。
 */
export type RecordedStatement = {
  sql: string;
  args: unknown[];
  /** 事务序号;null 表示事务外的自动提交语句。 */
  tx: number | null;
};

export type LiveSchema = IsolatedSchema & {
  prisma: PrismaClient;
  statements: RecordedStatement[];
  /** 另开一条直连(并发用例里扮演「另一个事务」)。 */
  connect: () => Promise<Client>;
};

const schemaDdl = prismaSchemaDdl;

export function readMigration(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

type Queryable = {
  queryRaw: (query: { sql: string; args: unknown[] }) => Promise<unknown>;
  executeRaw: (query: { sql: string; args: unknown[] }) => Promise<unknown>;
};

function record(
  target: Queryable,
  statements: RecordedStatement[],
  tx: number | null,
): void {
  const queryRaw = target.queryRaw.bind(target);
  const executeRaw = target.executeRaw.bind(target);
  target.queryRaw = (query) => {
    statements.push({ sql: query.sql, args: query.args, tx });
    return queryRaw(query);
  };
  target.executeRaw = (query) => {
    statements.push({ sql: query.sql, args: query.args, tx });
    return executeRaw(query);
  };
}

export async function openLiveSchema(prefix: string): Promise<LiveSchema> {
  const isolated = await openIsolatedSchema(prefix);
  await isolated.db.query(schemaDdl());
  const connectionString = process.env.POSTGRES_TEST_DATABASE_URL!;
  const searchPath = `-c search_path="${isolated.schema}",public`;
  const pool = new Pool({ connectionString, options: searchPath, max: 6 });
  const factory = new PrismaPg(pool, { schema: isolated.schema });
  const statements: RecordedStatement[] = [];
  let txSeq = 0;
  const connect = factory.connect.bind(factory);
  factory.connect = async () => {
    const adapter = await connect();
    record(adapter as unknown as Queryable, statements, null);
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args) => {
      const transaction = await startTransaction(...args);
      const id = (txSeq += 1);
      statements.push({ sql: 'BEGIN', args: [], tx: id });
      record(transaction as unknown as Queryable, statements, id);
      const commit = transaction.commit.bind(transaction);
      const rollback = transaction.rollback.bind(transaction);
      transaction.commit = () => {
        statements.push({ sql: 'COMMIT', args: [], tx: id });
        return commit();
      };
      transaction.rollback = () => {
        statements.push({ sql: 'ROLLBACK', args: [], tx: id });
        return rollback();
      };
      return transaction;
    };
    return adapter;
  };
  const prisma = new PrismaClient({ adapter: factory });
  const extra: Client[] = [];
  return {
    ...isolated,
    prisma,
    statements,
    connect: async () => {
      const client = new Client({ connectionString, options: searchPath });
      await client.connect();
      extra.push(client);
      return client;
    },
    close: async () => {
      for (const client of extra) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end().catch(() => undefined);
      }
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await isolated.close();
    },
  };
}

/**
 * 某个事务里、命中 marker 的那条语句之后到 COMMIT/ROLLBACK 之前的全部语句。
 * marker 通常是行锁语句(`FOR UPDATE`),返回值就是「持锁期间」跑过的语句。
 */
export function statementsAfter(
  statements: RecordedStatement[],
  marker: (sql: string) => boolean,
): RecordedStatement[] {
  const start = statements.findIndex(
    (statement) => statement.tx !== null && marker(statement.sql),
  );
  if (start < 0) throw new Error('marker statement not recorded');
  const tx = statements[start].tx;
  const inside: RecordedStatement[] = [];
  for (const statement of statements.slice(start + 1)) {
    if (statement.tx !== tx) continue;
    if (statement.sql === 'COMMIT' || statement.sql === 'ROLLBACK') break;
    inside.push(statement);
  }
  return inside;
}

/** 某个事务的全部语句(含 BEGIN/COMMIT)。 */
export function transactionOf(
  statements: RecordedStatement[],
  marker: (sql: string) => boolean,
): RecordedStatement[] {
  const hit = statements.find(
    (statement) => statement.tx !== null && marker(statement.sql),
  );
  if (!hit) throw new Error('marker statement not recorded');
  return statements.filter((statement) => statement.tx === hit.tx);
}

/** 等到 pid 对应的后端真的卡在锁上(并发用例的前置条件)。 */
export async function waitUntilBlocked(
  db: Client,
  matches: (query: string) => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ query: string }>(
      `SELECT query FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (rows.some((row) => matches(row.query))) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('no backend ever waited on the expected lock');
}

/** promise 在 ms 内落定返回结果,否则返回 'pending'(用于证明「没有被锁住」)。 */
export async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ value: T } | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'pending'>((done) => {
    timer = setTimeout(() => done('pending'), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 建最小可用的 User 行(id 同时当账号/邀请码/昵称)。User.accountId 外键指向
 * AccountIdentifier 注册表,先登记再插用户。
 */
export async function seedUsers(
  db: Client,
  ids: string[],
  extra: { role?: string; status?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO "AccountIdentifier" (value, "updatedAt")
     SELECT id, now() FROM unnest($1::text[]) AS id`,
    [ids],
  );
  await db.query(
    `INSERT INTO "User" (id, "accountId", "inviteCode", nickname, "passwordHash", "updatedAt", role, status)
     SELECT id, id, 'inv-' || id, id, 'x', now(), $2::"UserRole", $3::"UserStatus"
     FROM unnest($1::text[]) AS id`,
    [ids, extra.role ?? 'USER', extra.status ?? 'ACTIVE'],
  );
}
