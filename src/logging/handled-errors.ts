/**
 * Cross-layer "already handled" markers for one exception instance.
 *
 * The HTTP pipeline has two catch points that both see the same exception:
 * ErrorLoggingInterceptor (route handlers only — interceptors wrap the handler,
 * not guards, pipes or middleware) and AllExceptionFilter (everything). The
 * interceptor forwards 5xx failures to error aggregation and logs 401/403 as
 * security events; the filter must cover the paths the interceptor cannot see
 * (a guard rejecting a revoked session, Prisma failing inside a guard, a pipe
 * throwing) without double-reporting the ones it already handled. A WeakSet
 * keyed by the exception object is the cheapest correlation that survives the
 * rethrow and never retains the error beyond the request.
 */
const capturedErrors = new WeakSet<object>();
const securityLoggedErrors = new WeakSet<object>();

function isObject(error: unknown): error is object {
  return typeof error === 'object' && error !== null;
}

export function markErrorCaptured(error: unknown): void {
  if (isObject(error)) capturedErrors.add(error);
}

export function wasErrorCaptured(error: unknown): boolean {
  return isObject(error) && capturedErrors.has(error);
}

export function markSecurityEventLogged(error: unknown): void {
  if (isObject(error)) securityLoggedErrors.add(error);
}

export function wasSecurityEventLogged(error: unknown): boolean {
  return isObject(error) && securityLoggedErrors.has(error);
}
