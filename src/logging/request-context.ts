import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContext {
  requestId: string;
  traceId: string;
  method: string;
  path: string;
  ip?: string;
  userAgent?: string;
  userId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();
// Request IDs cross the log/Sentry boundary. Only accept the UUID shape our
// clients generate; arbitrary opaque strings can be account IDs, phone numbers
// or credentials even when they contain no whitespace.
const SAFE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveRequestId(value?: unknown): string {
  const requestId = Array.isArray(value) ? value[0] : value;

  if (typeof requestId === 'string' && SAFE_REQUEST_ID.test(requestId)) {
    return requestId.toLowerCase();
  }

  return randomUUID();
}

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return requestContextStorage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function setRequestUserId(userId?: string): void {
  const context = getRequestContext();
  if (context && userId) {
    context.userId = userId;
  }
}
