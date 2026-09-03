import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';

/**
 * Prisma known-request error codes the API deliberately maps to expected
 * client errors. Shared by PrismaExceptionFilter (which builds the response)
 * and ErrorLoggingInterceptor (which decides what counts as a server error) so
 * a unique-constraint race (P2002 → 409) is never logged as a 500 or forwarded
 * to error aggregation as an incident.
 */
const PRISMA_KNOWN_ERROR_STATUS: ReadonlyMap<string, number> = new Map([
  ['P2002', HttpStatus.CONFLICT],
  ['P2025', HttpStatus.NOT_FOUND],
  ['P2003', HttpStatus.BAD_REQUEST],
]);

export function resolvePrismaKnownErrorStatus(
  code: string,
): number | undefined {
  return PRISMA_KNOWN_ERROR_STATUS.get(code);
}

export function isPrismaKnownRequestError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

/**
 * The HTTP status the response pipeline will end up sending for `error`:
 * HttpException carries its own, known Prisma codes follow the map above, and
 * anything else is an unexpected 500.
 */
export function resolveErrorStatusCode(error: unknown): number {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  if (isPrismaKnownRequestError(error)) {
    return (
      resolvePrismaKnownErrorStatus(error.code) ??
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
