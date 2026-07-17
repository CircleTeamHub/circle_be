import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma';
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

/** The pg pool knobs we expose — named to match pg's `PoolConfig` fields. */
export interface DatabasePoolConfig {
  max: number;
  connectionTimeoutMillis: number;
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

    super(
      connectionString
        ? {
            adapter: new PrismaPg({ connectionString, ...poolConfig }),
          }
        : {},
    );

    this.connectionString = connectionString;
    this.allowStartWithoutDb = allowStartWithoutDb;
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
