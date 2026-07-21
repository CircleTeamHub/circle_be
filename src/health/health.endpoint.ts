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

/**
 * The slice of UploadService the readiness probe reports on.
 *
 * `policy-unconfirmed` is the one worth staring at: the bucket policy is a
 * **whitelist** and `notes/` was removed from it, so *applying* that policy is
 * what makes private note media private. Applying it is best-effort at boot —
 * when it fails the previous (permissive) policy stays in force, the bucket
 * keeps serving `notes/*` anonymously, and the app happily mints presigned URLs
 * as if the fix were live. Nothing else surfaces that gap.
 */
export interface HealthObjectStore {
  objectStoreStatus(): 'ok' | 'policy-unconfirmed' | 'disabled';
}

export interface ReadinessDependencies {
  database: HealthDatabase;
  /** Absent when RedisModule could not be resolved; reported as `disabled`. */
  redis?: HealthRedis | null;
  /** Absent when UploadService could not be resolved; reported as `disabled`. */
  objectStore?: HealthObjectStore | null;
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
 *
 * The object store is reported on the same terms, for a sharper reason: an
 * unapplied bucket policy is identical on every replica, so gating readiness on
 * it would pull the whole fleet at once — turning an observable security
 * degradation into a total outage. Report it loudly; let operators act.
 */
export function createReadinessHandler({
  database,
  redis,
  objectStore,
}: ReadinessDependencies) {
  return async (_req: Request, res: Response): Promise<void> => {
    const [databaseUp, redisStatus] = await Promise.all([
      checkDatabase(database),
      checkRedis(redis),
    ]);
    const objectStoreStatus = objectStore?.objectStoreStatus() ?? 'disabled';

    if (objectStoreStatus === 'policy-unconfirmed') {
      // The probe body stays terse; this is the only place the consequence is
      // spelled out for whoever is reading logs during an incident.
      logger.error(
        'Object store bucket policy was never confirmed applied — private note media (notes/*) may still be anonymously readable despite presigned-URL reads being active.',
      );
    }

    res.status(databaseUp ? 200 : 503).json({
      status: databaseUp ? 'ok' : 'error',
      database: databaseUp ? 'up' : 'down',
      redis: redisStatus,
      objectStore: objectStoreStatus,
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
