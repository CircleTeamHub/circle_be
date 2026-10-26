import { Prisma } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';

/**
 * 重试次数与退避。原来是失败后立刻重来、共 3 次:热点行上的冲突方会在同一瞬间
 * 一起重试、再一起撞上,第三次照样失败,冲突就成了 500。现在每次重试前按指数
 * 退避等一会儿(带抖动,把撞在一起的重试错开),总共 5 次;最坏情况下多等
 * ≈ 25+50+100+200 = 375ms,换掉的是一次 500。
 */
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 1_000;

export type SerializableTransactionOptions = {
  maxAttempts?: number;
  /** 第一次重试前的退避窗口;之后每次翻倍。 */
  baseDelayMs?: number;
  /** 单次退避的上限。 */
  maxDelayMs?: number;
  /** 透传给 Prisma 交互事务(默认 5000ms / 2000ms)。 */
  timeout?: number;
  maxWait?: number;
};

/**
 * 第 attempt 次失败之后、下一次重试之前的等待:窗口 = base·2^(attempt-1),封顶
 * maxDelay;实际等待在窗口的后一半里均匀取(「等量抖动」)—— 既把并发的重试错开,
 * 又保证至少退让半个窗口,不会抖到 0 又立刻撞上。
 */
export function serializableRetryDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const window = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(window / 2 + Math.random() * (window / 2 + 1));
}

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
 * `maxAttempts` times, backing off (exponential, jittered) before each retry.
 * This is the single source of truth for the "Serializable + retry" pattern —
 * coin / circle / circle-invitation each used to carry their own copy.
 *
 * Use it for any multi-row write that must be atomic under concurrency.
 * Other errors (validation, unique conflict, etc.) propagate immediately.
 */
export async function runSerializableTransaction<T>(
  prisma: PrismaService,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableTransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const transactionOptions = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.maxWait !== undefined ? { maxWait: options.maxWait } : {}),
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(fn, transactionOptions);
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < maxAttempts) {
        const delay = serializableRetryDelayMs(
          attempt,
          options.baseDelayMs,
          options.maxDelayMs,
        );
        await new Promise<void>((resume) => setTimeout(resume, delay));
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop above either returns or throws on every path.
  throw new Error('runSerializableTransaction: attempts exhausted');
}
