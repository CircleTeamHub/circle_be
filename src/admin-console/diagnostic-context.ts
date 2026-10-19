import {
  DYNAMIC_ROUTE_TEMPLATES,
  STATIC_ROUTES,
} from 'src/metrics/route-normalizer';

export const DIAGNOSTIC_CAUSES = new Set([
  'DATABASE_QUERY_INVALID',
  'DATABASE_UNAVAILABLE',
  'DATABASE_REQUEST_FAILED',
  'INPUT_INVALID',
  'LOGIN_EXPIRED',
  'PERMISSION_DENIED',
  'RECORD_NOT_FOUND',
  'STATE_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);
export function diagnosticCause(error: unknown, status: number): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PrismaClientValidationError') return 'DATABASE_QUERY_INVALID';
  if (name === 'PrismaClientInitializationError') return 'DATABASE_UNAVAILABLE';
  if (
    name === 'PrismaClientKnownRequestError' ||
    name === 'PrismaClientUnknownRequestError'
  )
    return 'DATABASE_REQUEST_FAILED';
  return (
    (
      {
        400: 'INPUT_INVALID',
        401: 'LOGIN_EXPIRED',
        403: 'PERMISSION_DENIED',
        404: 'RECORD_NOT_FOUND',
        409: 'STATE_CONFLICT',
        429: 'RATE_LIMITED',
      } as Record<number, string>
    )[status] ?? 'INTERNAL_ERROR'
  );
}
export function diagnosticContext(metadata: unknown) {
  const value =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const method =
    typeof value.method === 'string' &&
    ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(value.method)
      ? value.method
      : null;
  // Only registered route templates can leave the server, never raw URLs or user IDs.
  const route =
    typeof value.route === 'string' && value.route.length < 240
      ? value.route.startsWith('/api/v1/')
        ? value.route
        : `/api/v1${value.route}`
      : null;
  const registered =
    route &&
    (STATIC_ROUTES.has(route)
      ? route
      : DYNAMIC_ROUTE_TEMPLATES.find((template) => {
          const actual = route.split('/'),
            expected = template.split('/');
          return (
            actual.length === expected.length &&
            expected.every((part, index) =>
              part.startsWith(':')
                ? /^:[a-zA-Z][a-zA-Z0-9_]*$/.test(actual[index])
                : part === actual[index],
            )
          );
        }));
  return {
    requestMethod: method,
    requestRoute: registered || null,
    failureCause:
      typeof value.failureCause === 'string' &&
      DIAGNOSTIC_CAUSES.has(value.failureCause)
        ? value.failureCause
        : null,
  };
}
