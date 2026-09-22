import { HttpException, LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';
import { safeLogPath, sanitizeLogValue } from './log-sanitizer';

// Interceptor and exception filter may see the same object in one request.
// Key deduplication by request, not object lifetime: SDKs sometimes reuse one
// Error instance across requests and each request still needs diagnostics.
const loggedErrorRequestIds = new WeakMap<object, string>();

/** Diagnostics must never replace a response, rejection, or business result. */
export function attemptDiagnostic(
  write: () => void,
  onFailure?: () => void,
): void {
  try {
    write();
  } catch {
    // A fallback is best-effort too; never recursively report transport failure.
    if (onFailure) {
      try {
        onFailure();
      } catch {
        /* Preserve the business result. */
      }
    }
  }
}

type FailureRequest = {
  method?: string;
  url?: string;
  originalUrl?: string;
  user?: { userId?: string };
};

export function logHttpFailure(
  logger: LoggerService,
  error: unknown,
  statusCode: number,
  request?: FailureRequest,
): void {
  attemptDiagnostic(() => {
    const object =
      typeof error === 'object' && error !== null ? error : undefined;
    const context = getRequestContext();
    if (
      object &&
      context?.requestId &&
      loggedErrorRequestIds.get(object) === context.requestId
    )
      return;
    const response =
      error instanceof HttpException ? error.getResponse() : undefined;
    const candidateCode =
      response && typeof response === 'object'
        ? (response as Record<string, unknown>).errorCode
        : undefined;
    const code =
      typeof candidateCode === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(candidateCode)
        ? candidateCode
        : undefined;
    const prismaCode =
      object &&
      'code' in object &&
      typeof object.code === 'string' &&
      /^P\d{4}$/.test(object.code)
        ? object.code
        : undefined;
    const payload = {
      event: 'http_error',
      statusCode,
      requestId: context?.requestId,
      traceId: context?.traceId,
      method: context?.method ?? request?.method,
      path: safeLogPath(
        context?.path ?? request?.originalUrl ?? request?.url ?? '',
      ),
      userId: context?.userId ?? request?.user?.userId,
      errorName:
        error instanceof Error &&
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
          ? error.name
          : 'UnknownError',
      errorCode: code ?? prismaCode,
      error:
        statusCode >= 500 && error instanceof Error
          ? sanitizeLogValue(error)
          : undefined,
    };
    if (statusCode >= 500) logger.error(payload, 'HttpError');
    else logger.warn(payload, 'HttpError');
    if (object && context?.requestId)
      loggedErrorRequestIds.set(object, context.requestId);
  });
}
