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

/**
 * Why JwtGuard rejected a bearer token, taken from passport's `info` — the
 * guard is the only layer that sees it, the filter is the only layer that
 * logs. Most 401s on a JWT API are routine (a client whose access token just
 * rotated, a scanner hitting an authenticated route without a header); logging
 * each one as a security event buries the rare named signals such as
 * `session_revoked_token_used`.
 */
export type AuthFailureReason =
  | 'token_missing'
  | 'token_expired'
  | 'token_not_active'
  | 'token_invalid';

const ROUTINE_AUTH_FAILURES: ReadonlySet<AuthFailureReason> =
  new Set<AuthFailureReason>(['token_missing', 'token_expired']);
const authFailureReasons = new WeakMap<object, AuthFailureReason>();

function isObject(error: unknown): error is object {
  return typeof error === 'object' && error !== null;
}

export function markAuthFailureReason(
  error: unknown,
  reason: AuthFailureReason,
): void {
  if (isObject(error)) authFailureReasons.set(error, reason);
}

export function getAuthFailureReason(
  error: unknown,
): AuthFailureReason | undefined {
  return isObject(error) ? authFailureReasons.get(error) : undefined;
}

/** True only for classified rejections that are expected client churn. */
export function isRoutineAuthFailure(error: unknown): boolean {
  const reason = getAuthFailureReason(error);
  return reason !== undefined && ROUTINE_AUTH_FAILURES.has(reason);
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
