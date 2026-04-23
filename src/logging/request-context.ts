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
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(value?: unknown): string {
  const requestId = Array.isArray(value) ? value[0] : value;

  if (typeof requestId === 'string' && SAFE_REQUEST_ID.test(requestId)) {
    return requestId;
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
