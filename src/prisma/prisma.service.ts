import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from 'src/generated/prisma';
import type { PoolStats } from 'src/metrics/db-pool.metrics';
import {
  allowsStartWithoutDatabase,
  shouldSkipPrismaConnectOnBoot,
} from 'src/config/env.validation';
import { getServerConfig } from 'src/config/server.config';

/** pg's own default pool size — keeping it as the default makes tuning opt-in. */
const DEFAULT_POOL_MAX = 10;
/**
 * Cap on how long a query waits for a free pool slot. pg defaults this to 0,
 * meaning "queue forever": once the pool saturates, requests pile up silently
 * and the process keeps looking alive while serving nothing. Failing fast turns
 * that into a visible error instead.
 */
const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 10_000;
/**
 * 单条语句在服务端的最长执行时间。Postgres 默认 0 = 不限。
 *
 * 没有它时，一条昂贵的查询（缺索引的数组包含过滤、深 OFFSET、大表 count）会一直
 * 占着自己那个连接直到跑完 —— 池只有 10 个，几个这样的请求就足以让整个实例的其它
 * 请求全卡在 connectionTimeoutMillis 上。也就是说上面那个「取连接超时」只让饥饿
 * 变得可见，真正该限的是单条语句能占多久。
 *
 * 15s 远高于任何正常查询（p95 是毫秒级），只用来兜住失控的那种：越界的语句拿到
 * Postgres 的 57014 错误并立刻归还连接，而不是把整个池拖垮。
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/** The pg pool knobs we expose — named to match pg's `PoolConfig` fields. */
export interface DatabasePoolConfig {
  max: number;
  connectionTimeoutMillis: number;
  /** snake_case 是 pg 的字段名（它直接透传给 Postgres），不是笔误。 */
  statement_timeout: number;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the pg pool settings from a merged env/config record. Unset or
 * unparseable values fall back to the defaults rather than failing boot — Joi
 * already rejects malformed values that arrive through ConfigModule, and this
 * also runs against the raw `.env.<NODE_ENV>` file read by getServerConfig().
 */
export function resolveDatabasePoolConfig(
  env: Record<string, unknown>,
): DatabasePoolConfig {
  return {
    max: readPositiveInt(env['DATABASE_POOL_MAX'], DEFAULT_POOL_MAX),
    connectionTimeoutMillis: readPositiveInt(
      env['DATABASE_POOL_ACQUIRE_TIMEOUT_MS'],
      DEFAULT_POOL_ACQUIRE_TIMEOUT_MS,
    ),
    statement_timeout: readPositiveInt(
      env['DATABASE_STATEMENT_TIMEOUT_MS'],
      DEFAULT_STATEMENT_TIMEOUT_MS,
    ),
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly connectionString: string;
  private readonly allowStartWithoutDb: boolean;
  /** 我们自己创建、因此也由我们负责销毁的池。见 onModuleDestroy。 */
  private readonly pool: Pool | null;
  /** 配置上限。pg.Pool 不暴露 max，只能自己记着。 */
  private readonly poolMax: number;
  private isConnected = false;

  constructor() {
    const config = getServerConfig();
    const connectionString =
      process.env.DATABASE_URL ??
      (config['DATABASE_URL'] as string | undefined) ??
      '';
    const allowStartWithoutDb = allowsStartWithoutDatabase(process.env);

    if (!connectionString && !allowStartWithoutDb) {
      throw new Error(
        'DATABASE_URL is not configured. Set it in your environment or .env file.',
      );
    }

    // process.env wins over the .env file, same precedence as DATABASE_URL above.
    const poolConfig = resolveDatabasePoolConfig({ ...config, ...process.env });

    // 自己建池再交给适配器，而不是把配置丢给 PrismaPg 让它内部建 ——
    // 为的是留住这个引用：pg.Pool 的 waitingCount 是「有多少请求正在排队等
    // 连接」的确定读数，而池排队恰恰是 postgres-exporter 看不见的那类故障
    // （从 Postgres 视角一切正常，应用侧已经在 connectionTimeoutMillis 上排队）。
    //
    // Prisma 自带的 $metrics 在 Prisma 7 已被移除（previewFeatures = ["metrics"]
    // 会直接报 P1012），所以这是拿到池遥测的唯一途径。
    const pool = connectionString
      ? new Pool({ connectionString, ...poolConfig })
      : null;

    super(pool ? { adapter: new PrismaPg(pool) } : {});

    this.pool = pool;
    this.poolMax = poolConfig.max;
    this.connectionString = connectionString;
    this.allowStartWithoutDb = allowStartWithoutDb;
  }

  /**
   * 连接池实时读数，供 `/metrics` 抓取时求值。读的全是内存计数器，无 I/O。
   * 无 DATABASE_URL 启动时返回 null —— 调用方据此不注册这几条 gauge，
   * 而不是让它们恒 0（恒 0 看起来像「池很空闲」，正好是相反的结论）。
   */
  getPoolStats(): PoolStats | null {
    if (!this.pool) return null;
    return {
      max: this.poolMax,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /** 仅供单测断言适配器拿到的是同一个池实例。 */
  getPoolForTest(): Pool | null {
    return this.pool;
  }

  async onModuleInit() {
    if (this.shouldSkipConnectionOnBoot()) {
      this.logger.warn(
        'Skipping Prisma connection during bootstrap because startup connection is disabled or DATABASE_URL is unavailable.',
      );
      return;
    }

    try {
      await this.$connect();
      this.isConnected = true;
      this.logger.log('PrismaClient connected to database successfully');
    } catch (error) {
      this.isConnected = false;

      if (this.allowStartWithoutDb) {
        this.logger.error(
          `Database connection error: ${error instanceof Error ? error.message : String(error)}`,
          'Application will continue without database connection.',
        );
        return;
      }

      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.isConnected = false;
    // @prisma/adapter-pg 只在**自己**创建池时负责销毁它（内部用 externalPool
    // 区分）。既然改成由这里建池，关闭责任也一并转移过来 —— 漏掉这一步，每次
    // 优雅重启都会留下一把不归还的 Postgres 连接，蓝绿发布下尤其明显。
    //
    // 已经关过的池再 end 会抛；关闭失败不该让整个 shutdown 挂掉。
    try {
      await this.pool?.end();
    } catch (error) {
      this.logger.warn(
        `Failed to close the pg pool during shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  isDatabaseConnected(): boolean {
    return this.isConnected;
  }

  async connectIfNeeded(): Promise<boolean> {
    if (this.isConnected) {
      return true;
    }

    if (!this.connectionString) {
      this.logger.warn(
        'Database connection requested but DATABASE_URL is not configured.',
      );
      return false;
    }

    try {
      await this.$connect();
      this.isConnected = true;
      this.logger.log('PrismaClient connected to database successfully');
      return true;
    } catch (error) {
      this.isConnected = false;
      this.logger.error(
        `Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private shouldSkipConnectionOnBoot(): boolean {
    if (!this.connectionString) {
      return true;
    }

    return shouldSkipPrismaConnectOnBoot(process.env);
  }
}
