import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { prismaSchemaDdl } from './prisma-schema-ddl';
import { Client, Pool, type PoolClient } from 'pg';
import { PrismaClient } from 'src/generated/prisma';

/**
 * 圈子事务回归(circle-tx-*.pg-spec.ts)的公共底座:在隔离 schema 里建出
 * prisma/schema.prisma 的完整表结构,用真 PrismaClient + 真 pg 连接池跑 src 里的
 * service —— 锁、隔离级别、40001/40P01 都是 PostgreSQL 自己给的,不是 mock 出来的。
 *
 * 连接池带两样观测:同一时刻借出的连接数(峰值),以及每条连接按顺序发出的 SQL
 * (含 BEGIN/COMMIT),用来断言「事务的形状」而不只是结果。
 */
const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;

let schemaSql: string | undefined;

/** schema.prisma → 建表 SQL。每个进程算一次;源是 schema 本身,不手抄。 */
function prismaSchemaSql(): string {
  if (schemaSql) return schemaSql;
  schemaSql = prismaSchemaDdl().replace(
    'CREATE SCHEMA IF NOT EXISTS "public";',
    '',
  );
  return schemaSql;
}

export type StatementLog = Array<{ connection: number; sql: string }>;

export type CircleTxDb = {
  schema: string;
  prisma: PrismaClient;
  pool: Pool;
  /** 当前借出的连接数。 */
  activeConnections: () => number;
  /** 自上次 resetPeak 以来同一时刻借出连接数的峰值。 */
  peakConnections: () => number;
  resetPeak: () => void;
  /** recording=true 期间每条连接发出的 SQL,按发出顺序。 */
  statements: StatementLog;
  setRecording: (on: boolean) => void;
  /** 另开一条直连(不经连接池),search_path 指向隔离 schema。 */
  rawClient: () => Promise<Client>;
  close: () => Promise<void>;
};

export async function openCircleTxDb(
  prefix: string,
  options: { extraSql?: string[]; poolMax?: number } = {},
): Promise<CircleTxDb> {
  const schema = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}", public`);
  await admin.query(prismaSchemaSql());
  for (const sql of options.extraSql ?? []) await admin.query(sql);

  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.poolMax ?? 10,
    options: `-c search_path=${schema},public`,
  });
  let active = 0;
  let peak = 0;
  let recording = false;
  let nextConnection = 0;
  const statements: StatementLog = [];
  const tracked = new WeakSet<PoolClient>();
  pool.on('acquire', (client: PoolClient) => {
    active += 1;
    peak = Math.max(peak, active);
    if (tracked.has(client)) return;
    tracked.add(client);
    const connection = (nextConnection += 1);
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      const first = args[0] as string | { text?: string } | undefined;
      const sql = typeof first === 'string' ? first : first?.text;
      if (recording && sql) statements.push({ connection, sql });
      return original(...args);
    };
  });
  pool.on('release', () => {
    active -= 1;
  });

  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });

  return {
    schema,
    prisma,
    pool,
    activeConnections: () => active,
    peakConnections: () => peak,
    resetPeak: () => {
      peak = active;
    },
    statements,
    setRecording: (on) => {
      recording = on;
      if (on) statements.length = 0;
    },
    rawClient: async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await client.query(`SET search_path TO "${schema}", public`);
      return client;
    },
    close: async () => {
      try {
        await prisma.$disconnect();
        // 外部传入的池由我们自己收;Prisma 断开时是否已经 end 过因版本而异。
        await pool.end().catch(() => undefined);
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    },
  };
}

/** 建 n 个用户(带账号号段),返回按创建顺序的 id。 */
export async function createUsers(
  prisma: PrismaClient,
  count: number,
  data: { vipLevel?: number; vipExpiresAt?: Date | null } = {},
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await prisma.accountIdentifier.createMany({
    data: ids.map((value) => ({ value })),
  });
  await prisma.user.createMany({
    data: ids.map((id, index) => ({
      id,
      accountId: id,
      inviteCode: id,
      passwordHash: 'test-only',
      nickname: `u${index}`,
      ...data,
    })),
  });
  return ids;
}

/** 建一个圈子,圈主 ACTIVE OWNER,其余成员 ACTIVE MEMBER;memberCount 与成员行一致。 */
export async function createCircle(
  prisma: PrismaClient,
  ownerID: string,
  members: string[] = [],
  data: {
    requiredVerifierCount?: number;
    maxMembers?: number | null;
    memberCanInvite?: boolean;
  } = {},
): Promise<string> {
  const circle = await prisma.circle.create({
    data: {
      name: `circle-${randomUUID().slice(0, 8)}`,
      ownerID,
      memberCount: 1 + members.length,
      ...data,
      members: {
        create: [
          { userID: ownerID, role: 'OWNER', status: 'ACTIVE' },
          ...members.map((userID) => ({
            userID,
            role: 'MEMBER' as const,
            status: 'ACTIVE' as const,
          })),
        ],
      },
    },
    select: { id: true },
  });
  return circle.id;
}

/** 某条连接(按 statements 里的编号)在 BEGIN … COMMIT 之间发出的语句。 */
export function transactionsOf(statements: StatementLog): string[][] {
  const open = new Map<number, string[]>();
  const done: string[][] = [];
  for (const { connection, sql } of statements) {
    const head = sql.trim().toUpperCase();
    if (head.startsWith('BEGIN')) {
      open.set(connection, [sql]);
      continue;
    }
    const current = open.get(connection);
    if (!current) continue;
    current.push(sql);
    if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) {
      done.push(current);
      open.delete(connection);
    }
  }
  return done;
}

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

export async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  return rows[0].pid;
}

/**
 * 轮询直到有 count 个后端在等 blocker 持有的锁,返回这些等待者的 pid。并发用例必须
 * 先确认对方真的卡住了再放行,否则「没死锁」可能只是两边根本没交错。
 */
export async function waitUntilBlockedBy(
  observer: Client,
  blockerPid: number,
  count = 1,
  timeoutMs = 5000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE $1 = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (rows.length >= count) return rows.map((row) => row.pid);
    await sleep(10);
  }
  throw new Error(`expected ${count} backend(s) to block on pid ${blockerPid}`);
}
