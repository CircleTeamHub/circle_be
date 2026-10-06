import type { LoggerService } from '@nestjs/common';
import type { PrismaPg } from '@prisma/adapter-pg';
import { createHash } from 'crypto';
import type { SqlQuery } from '@prisma/driver-adapter-utils';
import { getRequestContext } from './request-context';
import { getOperationContext } from './operation-context';

type Adapter = Awaited<ReturnType<PrismaPg['connect']>>;
type Queryable = Pick<Adapter, 'queryRaw' | 'executeRaw'>;

function queryFingerprint(query: SqlQuery): string | undefined {
  if (typeof query.sql !== 'string' || query.sql.trim().length === 0) {
    return undefined;
  }
  const normalized = query.sql.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Time the public driver-adapter query boundary, including transaction queries.
 * This is a driver round trip (and pool wait for non-transaction queries), not
 * PostgreSQL execution time or an entire Prisma/model operation. The adapter
 * cannot expose a model name without retaining SQL, so operation names are
 * deliberately limited to queryRaw/executeRaw. SQL is only normalized into a
 * one-way fingerprint for grouping; args, results and error messages are never
 * logged. PrismaPromise and transaction lifecycle remain intact.
 */
export function observeDatabaseAdapter(
  factory: PrismaPg,
  logger: LoggerService,
  config: { performanceLogOn: boolean; slowDbOperationMs: number },
  elapsedMs = () => performance.now(),
  warningNowMs = () => performance.now(),
): PrismaPg {
  if (!config.performanceLogOn) return factory;
  const warningIntervalMs = 60_000;
  const warningStates = new Map<
    string,
    { lastEmittedAt: number; suppressedCount: number }
  >();

  function shouldEmitWarning(key: string): number | null {
    const now = warningNowMs();
    const state = warningStates.get(key);
    if (!state || now - state.lastEmittedAt >= warningIntervalMs) {
      const suppressedCount = state?.suppressedCount ?? 0;
      warningStates.set(key, { lastEmittedAt: now, suppressedCount: 0 });
      return suppressedCount;
    }
    state.suppressedCount += 1;
    return null;
  }

  async function timed<T>(
    operation: 'queryRaw' | 'executeRaw',
    query: SqlQuery,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = elapsedMs();
    let result: 'success' | 'failure' = 'success';
    try {
      return await run();
    } catch (error) {
      result = 'failure';
      throw error;
    } finally {
      try {
        const durationMs = elapsedMs() - startedAt;
        const suppressedCount =
          durationMs >= config.slowDbOperationMs
            ? shouldEmitWarning(`${operation}:${result}`)
            : null;
        if (suppressedCount !== null) {
          const requestContext = getRequestContext();
          const fingerprint = queryFingerprint(query);
          logger.warn(
            {
              event: 'database_operation_slow',
              scope: 'driver_adapter',
              operation,
              durationMs,
              thresholdMs: config.slowDbOperationMs,
              result,
              suppressedCount,
              requestId: requestContext?.requestId,
              traceId: requestContext?.traceId,
              ...(fingerprint ? { queryFingerprint: fingerprint } : {}),
              ...getOperationContext(),
            },
            'Performance',
          );
        }
      } catch {
        // A logging outage must not change a database result or transaction.
      }
    }
  }

  function observeQueries(queryable: Queryable): void {
    const queryRaw = queryable.queryRaw.bind(queryable);
    const executeRaw = queryable.executeRaw.bind(queryable);
    queryable.queryRaw = (query) =>
      timed('queryRaw', query, () => queryRaw(query));
    queryable.executeRaw = (query) =>
      timed('executeRaw', query, () => executeRaw(query));
  }

  const connect = factory.connect.bind(factory);
  factory.connect = async () => {
    const adapter = await connect();
    observeQueries(adapter);
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args) => {
      const transaction = await startTransaction(...args);
      observeQueries(transaction);
      return transaction;
    };
    return adapter;
  };
  return factory;
}
