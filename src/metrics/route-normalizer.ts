/**
 * Normalizes a request path into a low-cardinality route label for Prometheus.
 *
 * Labeling metrics by the raw path (`/circle/<uuid>`) would create a new time
 * series per id and blow up Prometheus cardinality — the #1 self-hosted footgun.
 * This first matches known Nest route templates (including string ids and
 * bearer-style link tokens), then falls back to collapsing UUIDs, Mongo
 * ObjectIds, and numeric ids to `:id`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONGO_OBJECT_ID = /^[0-9a-f]{24}$/i;
const NUMERIC = /^\d+$/;
// Exported for the drift-guard test (route-normalizer.spec.ts) — keep these in
// sync with the real router when adding controllers, or new routes silently
// fall to the id-collapse fallback.
export const STATIC_ROUTES = new Set([
  '/api/v1/auth/admin/login',
  '/api/v1/auth/admin/refresh',
  '/api/v1/auth/change-account-id',
  '/api/v1/auth/change-password',
  '/api/v1/auth/email/request-code',
  '/api/v1/auth/login',
  '/api/v1/auth/login/code',
  '/api/v1/auth/logout',
  '/api/v1/auth/logout-all',
  '/api/v1/auth/logout-others',
  '/api/v1/auth/me',
  '/api/v1/auth/refresh',
  '/api/v1/auth/register',
  '/api/v1/auth/security-code',
  '/api/v1/auth/security-code/verify',
  '/api/v1/auth/sessions',
  '/api/v1/auth/single-device-login',
  '/api/v1/calls/group',
  '/api/v1/calls/livekit/webhook',
  '/api/v1/circle',
  '/api/v1/circle/my',
  '/api/v1/circle-invitation/invite',
  '/api/v1/circle-invitation/my-applications',
  '/api/v1/circle-invitation/pending',
  '/api/v1/circle-plaza/feed',
  '/api/v1/circle-plaza/me/posts',
  '/api/v1/circle-plaza/me/signups/unread-count',
  '/api/v1/circle-plaza/posts',
  '/api/v1/coin/gift',
  '/api/v1/coin/transactions',
  '/api/v1/coin/wallet',
  '/api/v1/collections',
  '/api/v1/conversation-groups',
  '/api/v1/friend',
  '/api/v1/friend/activities',
  '/api/v1/friend/activities/unread-count',
  '/api/v1/friend/block',
  '/api/v1/friend/blocked',
  '/api/v1/friend/requests',
  '/api/v1/friend/requests/incoming',
  '/api/v1/friend/requests/outgoing',
  '/api/v1/friend/tags',
  '/api/v1/group',
  '/api/v1/icon/display',
  '/api/v1/icon/options',
  '/api/v1/logs',
  '/api/v1/mall/sections',
  '/api/v1/membership/plans',
  '/api/v1/membership/upgrade',
  '/api/v1/note',
  '/api/v1/note/group',
  '/api/v1/note/group/order',
  '/api/v1/note/share-links',
  '/api/v1/notification/list',
  '/api/v1/notification/profile/read-all',
  '/api/v1/notification/read-all',
  '/api/v1/notification/unread-summary',
  '/api/v1/outbox/health',
  '/api/v1/privacy/settings',
  '/api/v1/roles',
  '/api/v1/temp-chat',
  '/api/v1/temp-chat/mine',
  '/api/v1/trace',
  '/api/v1/trace/feed',
  '/api/v1/trace/feed/new-count',
  '/api/v1/upload/presign',
  '/api/v1/user',
  '/api/v1/user/search/account',
]);
export const DYNAMIC_ROUTE_TEMPLATES = [
  '/api/v1/auth/sessions/:sessionId',
  '/api/v1/calls/:callId/accept',
  '/api/v1/calls/:callId/cancel',
  '/api/v1/calls/:callId/join-token',
  '/api/v1/calls/:callId/leave',
  '/api/v1/calls/:callId/reject',
  '/api/v1/chat-history/conversations/:conversationID/messages',
  '/api/v1/circle/:id',
  '/api/v1/circle/:id/avatar',
  '/api/v1/circle/:id/cover',
  '/api/v1/circle/:id/icon/select',
  '/api/v1/circle/:id/icon/upload',
  '/api/v1/circle/:id/join',
  '/api/v1/circle/:id/leave',
  '/api/v1/circle-invitation/:id',
  '/api/v1/circle-invitation/:id/add-verifier',
  '/api/v1/circle-invitation/:id/admin-approve',
  '/api/v1/circle-invitation/:id/respond',
  '/api/v1/circle-invitation/circle/:circleId/pending',
  '/api/v1/circle-plaza/me/posts/:id/signups',
  '/api/v1/circle-plaza/me/posts/:id/signups/read',
  '/api/v1/circle-plaza/posts/:id',
  '/api/v1/circle-plaza/posts/:id/signup',
  '/api/v1/circle-plaza/posts/:id/signups',
  '/api/v1/collections/:id',
  '/api/v1/conversation-groups/:id',
  '/api/v1/conversation-groups/:id/members',
  '/api/v1/friend/:friendUserId',
  '/api/v1/friend/:friendUserId/blacklist',
  '/api/v1/friend/:friendUserId/remark',
  '/api/v1/friend/:friendUserId/report',
  '/api/v1/friend/:friendUserId/settings',
  '/api/v1/friend/:friendUserId/tags',
  '/api/v1/friend/:friendUserId/tags/:tagId',
  '/api/v1/friend/activities/:activityId',
  '/api/v1/friend/activities/:activityId/read',
  '/api/v1/friend/block/:targetId',
  '/api/v1/friend/requests/:requestId',
  '/api/v1/friend/requests/:requestId/accept',
  '/api/v1/friend/requests/:requestId/reject',
  '/api/v1/friend/status/:targetId',
  '/api/v1/friend/tags/:tagId',
  '/api/v1/friend/tags/:tagId/friends',
  '/api/v1/group/:groupID/leave',
  '/api/v1/group/:groupID/members/:userID',
  '/api/v1/group/:groupID/members/invite',
  '/api/v1/group/:groupID/report',
  '/api/v1/note/:id',
  '/api/v1/note/:id/available',
  '/api/v1/note/:id/groups',
  '/api/v1/note/:id/pin',
  '/api/v1/note/group/:id',
  '/api/v1/notification/:id',
  '/api/v1/notification/:id/read',
  '/api/v1/roles/:id',
  '/api/v1/temp-chat/:id/end',
  '/api/v1/temp-chat/by-token/:token/join',
  '/api/v1/temp-chat/by-token/:token/meta',
  '/api/v1/trace/:id',
  '/api/v1/trace/:id/comment',
  '/api/v1/trace/:id/like',
  '/api/v1/trace/comment/:commentId',
  '/api/v1/user/:id',
  '/api/v1/user/:id/status',
];

function isDynamicSegment(segment: string): boolean {
  return (
    UUID.test(segment) || MONGO_OBJECT_ID.test(segment) || NUMERIC.test(segment)
  );
}

function matchesTemplate(pathSegments: string[], template: string): boolean {
  const templateSegments = template.split('/');
  return (
    pathSegments.length === templateSegments.length &&
    templateSegments.every((segment, index) =>
      segment.startsWith(':')
        ? pathSegments[index] !== ''
        : segment === pathSegments[index],
    )
  );
}

/** Count literal (non-`:param`) segments — higher means a more specific route. */
function literalSegmentCount(template: string): number {
  return template
    .split('/')
    .filter((segment) => segment !== '' && !segment.startsWith(':')).length;
}

export function normalizeRoute(path: string): string {
  if (!path) {
    return '/';
  }

  const rawPathname = path.split('?')[0];
  if (rawPathname === '' || rawPathname === '/') {
    return '/';
  }
  // Express routing is case-insensitive by default, so `/API/V1/CiRcLe/<id>`
  // reaches the same handler as `/api/v1/circle/<id>`. Paths arrive here as the
  // raw client spelling (req.path / req.originalUrl), so canonicalize before
  // matching — an exact-case match would miss every template and return the path
  // verbatim, leaking link tokens and minting a label per case permutation.
  // Safe because every literal segment in both allowlists is already lowercase
  // (enforced by the consistency tests); `:params` match regardless of case.
  const pathname = (
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname
  ).toLowerCase();

  if (STATIC_ROUTES.has(pathname)) {
    return pathname;
  }

  // Pick the MOST specific matching template (most literal segments) so a
  // concrete route like `/group/:id/members/invite` is not shadowed by a
  // same-length wildcard template like `/group/:id/members/:userID`.
  const pathSegments = pathname.split('/');
  const matchedTemplate = DYNAMIC_ROUTE_TEMPLATES.reduce<string | undefined>(
    (best, template) => {
      if (!matchesTemplate(pathSegments, template)) {
        return best;
      }
      if (
        best === undefined ||
        literalSegmentCount(template) > literalSegmentCount(best)
      ) {
        return template;
      }
      return best;
    },
    undefined,
  );
  if (matchedTemplate) {
    return matchedTemplate;
  }

  const normalized = pathname
    .split('/')
    .map((segment) => (isDynamicSegment(segment) ? ':id' : segment))
    .join('/');

  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}

/** Bucket every route over the unknown-route budget falls into. */
export const OTHER_ROUTE = '/__other__';

/** All routes the app actually serves — these are always allowed as labels. */
const KNOWN_ROUTES = new Set<string>([
  ...STATIC_ROUTES,
  ...DYNAMIC_ROUTE_TEMPLATES,
]);

/**
 * Max number of *unknown* (unlisted) routes ever emitted as distinct labels.
 * Bounds total `route` cardinality to |KNOWN_ROUTES| + this + 1.
 */
const MAX_UNKNOWN_ROUTES = 200;

/**
 * Cardinality guard for the `route` metric label.
 *
 * {@link normalizeRoute} collapses id-like segments, but a path made of
 * arbitrary non-id segments (e.g. 404 scanning `/api/v1/<random>`) is returned
 * verbatim — so unauthenticated request spam could otherwise mint an unbounded
 * number of `route` label values and exhaust Prometheus memory. Known routes
 * (static + templates) always pass; unknown routes are admitted up to a fixed
 * budget, after which everything else collapses to {@link OTHER_ROUTE}.
 *
 * Returns a stateful limiter so production uses one shared budget while tests
 * get an isolated instance.
 */
export function createRouteCardinalityLimiter(
  maxUnknownRoutes: number = MAX_UNKNOWN_ROUTES,
): (route: string) => string {
  const seenUnknown = new Set<string>();
  return (route: string): string => {
    if (KNOWN_ROUTES.has(route) || seenUnknown.has(route)) {
      return route;
    }
    if (seenUnknown.size >= maxUnknownRoutes) {
      return OTHER_ROUTE;
    }
    seenUnknown.add(route);
    return route;
  };
}

/** App-wide shared limiter used by the HTTP RED middleware. */
export const limitRouteCardinality = createRouteCardinalityLimiter();
