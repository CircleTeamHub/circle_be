import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

const logger = new Logger('HealthEndpoint');

/** The slice of PrismaService the readiness probe needs — keeps it unit-testable. */
export interface HealthDatabase {
  $queryRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown>;
}

/** The slice of RedisService the readiness probe reports on. */
export interface HealthRedis {
  isEnabled(): boolean;
  ping(): Promise<boolean>;
}

export interface ReadinessDependencies {
  database: HealthDatabase;
  /** Absent when RedisModule could not be resolved; reported as `disabled`. */
  redis?: HealthRedis | null;
}

/**
 * Liveness: is this process running and able to answer? Deliberately touches no
 * dependency — a liveness failure means "replace the container", and a database
 * outage must never trigger that (every replica would restart-loop while the
 * database recovers, turning a partial outage into a total one).
 */
export function createLivenessHandler() {
  return (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  };
}

/**
 * Readiness: should this process receive traffic? Verifies the database with a
 * real round-trip, because "the port is open" is not the same as "we can serve"
 * — that gap is exactly what lets a broken deploy look healthy.
 *
 * Redis is reported but never gates readiness: it is optional here (the app
 * degrades to per-instance rate limiting and realtime), so failing readiness on
 * it would take a serving instance out of rotation for a non-fatal condition.
 */
export function createReadinessHandler({
  database,
  redis,
}: ReadinessDependencies) {
  return async (_req: Request, res: Response): Promise<void> => {
    const [databaseUp, redisStatus] = await Promise.all([
      checkDatabase(database),
      checkRedis(redis),
    ]);

    res.status(databaseUp ? 200 : 503).json({
      status: databaseUp ? 'ok' : 'error',
      database: databaseUp ? 'up' : 'down',
      redis: redisStatus,
    });
  };
}

async function checkDatabase(database: HealthDatabase): Promise<boolean> {
  try {
    await database.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    // Log the cause here: the probe response stays deliberately terse (it is
    // unauthenticated), so this is the only place the reason is recorded.
    logger.error(
      'Readiness probe failed: database is unreachable',
      error instanceof Error ? error.stack : String(error),
    );
    return false;
  }
}

async function checkRedis(
  redis: HealthRedis | null | undefined,
): Promise<'up' | 'down' | 'disabled'> {
  if (!redis?.isEnabled()) {
    return 'disabled';
  }
  return (await redis.ping()) ? 'up' : 'down';
}
