/**
 * Cross-layer "already handled" markers for one exception instance.
 *
 * The HTTP pipeline has two catch points that both see the same exception:
 * ErrorLoggingInterceptor (route handlers only — interceptors wrap the handler,
 * not guards, pipes or middleware) and AllExceptionFilter (everything). The
 * interceptor forwards 5xx failures to error aggregation and logs 401/403 as
 * security events; the filter must cover the paths the interceptor cannot see
 * (a guard rejecting a revoked session, Prisma failing inside a guard, a pipe
 * throwing) without double-reporting the ones it already handled. A WeakMap
 * keyed by the exception object preserves correlation across the rethrow. The
 * request id is part of the marker so an SDK/cache that reuses
 * one Error object cannot suppress diagnostics for later requests.
 */
import { getRequestContext, type RequestContext } from './request-context';

type RequestMarkers = WeakSet<RequestContext>;
const capturedErrors = new WeakMap<object, RequestMarkers>();
const securityLoggedErrors = new WeakMap<object, RequestMarkers>();
const unscopedCapturedErrors = new WeakSet<object>();
const unscopedSecurityLoggedErrors = new WeakSet<object>();

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

function setRequestMarker(
  error: object,
  scoped: WeakMap<object, RequestMarkers>,
  unscoped: WeakSet<object>,
  requestContext?: RequestContext,
): void {
  if (!requestContext) {
    unscoped.add(error);
    return;
  }
  const markers = scoped.get(error) ?? new WeakSet<RequestContext>();
  markers.add(requestContext);
  scoped.set(error, markers);
}

function hasRequestMarker(
  error: object,
  scoped: WeakMap<object, RequestMarkers>,
  unscoped: WeakSet<object>,
  requestContext?: RequestContext,
): boolean {
  return (
    unscoped.has(error) ||
    Boolean(requestContext && scoped.get(error)?.has(requestContext))
  );
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

export function markErrorCaptured(
  error: unknown,
  requestContext = getRequestContext(),
): void {
  if (isObject(error))
    setRequestMarker(
      error,
      capturedErrors,
      unscopedCapturedErrors,
      requestContext,
    );
}

export function wasErrorCaptured(
  error: unknown,
  requestContext = getRequestContext(),
): boolean {
  return Boolean(
    isObject(error) &&
    hasRequestMarker(
      error,
      capturedErrors,
      unscopedCapturedErrors,
      requestContext,
    ),
  );
}

export function markSecurityEventLogged(
  error: unknown,
  requestContext = getRequestContext(),
): void {
  if (isObject(error))
    setRequestMarker(
      error,
      securityLoggedErrors,
      unscopedSecurityLoggedErrors,
      requestContext,
    );
}

export function wasSecurityEventLogged(
  error: unknown,
  requestContext = getRequestContext(),
): boolean {
  return Boolean(
    isObject(error) &&
    hasRequestMarker(
      error,
      securityLoggedErrors,
      unscopedSecurityLoggedErrors,
      requestContext,
    ),
  );
}
