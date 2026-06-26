/**
 * Normalizes a request path into a low-cardinality route label for Prometheus.
 *
 * Labeling metrics by the raw path (`/circle/<uuid>`) would create a new time
 * series per id and blow up Prometheus cardinality — the #1 self-hosted footgun.
 * This collapses dynamic segments (UUIDs, Mongo ObjectIds, numeric ids) to
 * `:id`, strips the query string and trailing slash, so all requests to one
 * route share a single series (`/circle/:id`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONGO_OBJECT_ID = /^[0-9a-f]{24}$/i;
const NUMERIC = /^\d+$/;

function isDynamicSegment(segment: string): boolean {
  return (
    UUID.test(segment) || MONGO_OBJECT_ID.test(segment) || NUMERIC.test(segment)
  );
}

export function normalizeRoute(path: string): string {
  if (!path) {
    return '/';
  }

  const pathname = path.split('?')[0];
  if (pathname === '' || pathname === '/') {
    return '/';
  }

  const normalized = pathname
    .split('/')
    .map((segment) => (isDynamicSegment(segment) ? ':id' : segment))
    .join('/');

  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}
