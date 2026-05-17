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

/**
 * Runs `fn` inside a Serializable transaction and retries on a write-conflict
 * (`P2034`) up to `maxAttempts` times. This is the single source of truth for
 * the "Serializable + retry" pattern — coin / circle / circle-invitation each
 * used to carry their own copy.
 *
 * Use it for any multi-row write that must be atomic under concurrency.
 * Non-`P2034` errors (validation, conflict, etc.) propagate immediately.
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
      if (prismaErrorCode(error) === 'P2034' && attempt < maxAttempts) {
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop above either returns or throws on every path.
  throw new Error('runSerializableTransaction: attempts exhausted');
}
