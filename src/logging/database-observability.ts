import type { LoggerService } from '@nestjs/common';
import type { PrismaPg } from '@prisma/adapter-pg';
import { getRequestContext } from './request-context';
import { getOperationContext } from './operation-context';

type Adapter = Awaited<ReturnType<PrismaPg['connect']>>;
type Queryable = Pick<Adapter, 'queryRaw' | 'executeRaw'>;

/**
 * Time the public driver-adapter query boundary, including transaction queries.
 * This is a driver round trip (and pool wait for non-transaction queries), not
 * PostgreSQL execution time or an entire Prisma/model operation. The adapter
 * cannot expose a model name without inspecting SQL, so operation names are
 * deliberately limited to queryRaw/executeRaw. SQL, args, results and errors
 * are never inspected. PrismaPromise and transaction lifecycle remain intact.
 */
export function observeDatabaseAdapter(
  factory: PrismaPg,
  logger: LoggerService,
  config: { performanceLogOn: boolean; slowDbOperationMs: number },
  elapsedMs = () => performance.now(),
): PrismaPg {
  if (!config.performanceLogOn) return factory;

  async function timed<T>(
    operation: 'queryRaw' | 'executeRaw',
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
        if (durationMs >= config.slowDbOperationMs) {
          const requestContext = getRequestContext();
          logger.warn(
            {
              event: 'database_operation_slow',
              scope: 'driver_adapter',
              operation,
              durationMs,
              thresholdMs: config.slowDbOperationMs,
              result,
              requestId: requestContext?.requestId,
              traceId: requestContext?.traceId,
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
    queryable.queryRaw = (query) => timed('queryRaw', () => queryRaw(query));
    queryable.executeRaw = (query) =>
      timed('executeRaw', () => executeRaw(query));
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
