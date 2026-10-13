import { Prisma } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Extracts the Prisma error code (`P2002`, `P2025`, `P2034`, …) from an
 * unknown thrown value, or `undefined` if it is not a recognizable Prisma
 * error. Centralizes what each module previously re-implemented inline.
 */
export function prismaErrorCode(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/**
 * Whether a failed transaction should be retried from the start.
 *
 * Prisma reports a write conflict from its own queries as `P2034`, but wraps
 * every database error raised by a raw query (`$queryRaw` / `$executeRaw`, e.g.
 * `SELECT ... FOR UPDATE`) as `P2010`, and unrecognised ones from other queries
 * as `P2039`. The original SQLSTATE lives in `meta.driverAdapterError.cause`.
 * Serialization failures and deadlocks are safe to retry in all three forms;
 * matching only `P2034` turned them into 500s.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  const code = prismaErrorCode(error);
  if (code === 'P2034') return true;
  if (code !== 'P2010' && code !== 'P2039') return false;
  const sqlState = (
    error as {
      meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
    }
  ).meta?.driverAdapterError?.cause?.originalCode;
  return typeof sqlState === 'string' && RETRYABLE_SQLSTATES.has(sqlState);
}

/**
 * Runs `fn` inside a Serializable transaction and retries on a write-conflict,
 * serialization failure or deadlock (see `isRetryableTransactionError`) up to
 * `maxAttempts` times. This is the single source of truth for
 * the "Serializable + retry" pattern — coin / circle / circle-invitation each
 * used to carry their own copy.
 *
 * Use it for any multi-row write that must be atomic under concurrency.
 * Other errors (validation, unique conflict, etc.) propagate immediately.
 */
export async function runSerializableTransaction<T>(
  prisma: PrismaService,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { maxAttempts?: number } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < maxAttempts) {
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop above either returns or throws on every path.
  throw new Error('runSerializableTransaction: attempts exhausted');
}
