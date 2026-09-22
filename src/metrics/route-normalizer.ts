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
  '/api/v1/admin/memberships/program/enable',
  '/api/v1/admin/avatar-frames/assets',
  '/api/v1/admin/friend-reports',
  '/api/v1/admin/community/circles',
  '/api/v1/admin/community/groups',
  '/api/v1/admin/dashboard',
  '/api/v1/admin/mall/fancy-numbers',
  '/api/v1/admin/mall/fancy-numbers/batch',
  '/api/v1/admin/mall/fancy-numbers/recommendations',
  '/api/v1/admin/mall/fancy-numbers/recommendations/order',
  '/api/v1/admin/moderation/group-reports',
  '/api/v1/admin/moderation/post-reports',
  '/api/v1/admin/sensitive-words',
  '/api/v1/admin/sensitive-words/add',
  '/api/v1/admin/sensitive-words/remove',
  '/api/v1/admin/system-announcements',
  '/api/v1/admin/support/agents',
  '/api/v1/admin/support/agents/audit-logs',
  '/api/v1/admin/support/recharge/orders',
  '/api/v1/admin/support/recharge/payment-codes',
  '/api/v1/admin/users',
  '/api/v1/auth/admin/login',
  '/api/v1/auth/admin/refresh',
  '/api/v1/auth/change-account-id',
  '/api/v1/auth/change-password',
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
  '/api/v1/auth/logout-all',
  '/api/v1/auth/logout-others',
  '/api/v1/auth/me',
  '/api/v1/auth/password/reset',
  '/api/v1/auth/password/reset-request',
  '/api/v1/auth/refresh',
  '/api/v1/auth/register',
  '/api/v1/auth/security-code',
  '/api/v1/auth/security-code/verify',
  '/api/v1/auth/sessions',
  '/api/v1/auth/single-device-login',
  '/api/v1/calls/group',
  '/api/v1/calls/current',
  '/api/v1/calls/direct',
  '/api/v1/calls/livekit/webhook',
  '/api/v1/chat/conversations',
  '/api/v1/chat/conversations/circle',
  '/api/v1/chat/conversations/direct',
  '/api/v1/chat/conversations/group',
  '/api/v1/chat/messages/search',
  '/api/v1/circle',
  '/api/v1/circle/my',
  '/api/v1/circle-invitation/invite',
  '/api/v1/circle-invitation/my-applications',
  '/api/v1/circle-invitation/pending',
  '/api/v1/circle-plaza/feed',
  '/api/v1/circle-plaza/feed/search',
  '/api/v1/circle-plaza/me/posts',
  '/api/v1/circle-plaza/me/signups/unread-count',
  '/api/v1/circle-plaza/posts',
  '/api/v1/avatar-frames/me',
  '/api/v1/avatar-frames/me/equipped',
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
  '/api/v1/friend/tags',
  '/api/v1/geo/reverse',
  '/api/v1/geo/search',
  '/api/v1/group',
  '/api/v1/group-expansions/products',
  '/api/v1/group-expansions/purchases',
  '/api/v1/icon/display',
  '/api/v1/icon/options',
  '/api/v1/mall/sections',
  '/api/v1/mall/fancy-numbers',
  '/api/v1/mall/fancy-numbers/availability',
  '/api/v1/mall/fancy-numbers/custom/purchase',
  '/api/v1/mall/fancy-numbers/custom/switch',
  '/api/v1/mall/fancy-numbers/me',
  '/api/v1/mall/fancy-numbers/renew',
  '/api/v1/membership/plans',
  '/api/v1/membership/program',
  '/api/v1/note',
  '/api/v1/note/collect',
  '/api/v1/note/group',
  '/api/v1/note/group/order',
  '/api/v1/note/recycle-bin',
  '/api/v1/note/share-links',
  '/api/v1/notification/circle-push-preference',
  '/api/v1/notification/list',
  '/api/v1/notification/profile/list',
  '/api/v1/notification/profile/read-all',
  '/api/v1/notification/push-token',
  '/api/v1/notification/push-token/revoke',
  '/api/v1/notification/read-all',
  '/api/v1/notification/unread-summary',
  '/api/v1/privacy/settings',
  '/api/v1/qr/tokens',
  '/api/v1/qr/tokens/rotate',
  '/api/v1/referrals/me',
  '/api/v1/support/config',
  '/api/v1/temp-chat',
  '/api/v1/temp-chat/guest/members',
  '/api/v1/temp-chat/guest/messages',
  '/api/v1/temp-chat/guest/upload-presign',
  '/api/v1/temp-chat/mine',
  '/api/v1/trace',
  '/api/v1/trace/feed',
  '/api/v1/trace/feed/new-count',
  '/api/v1/upload/presign',
  '/api/v1/user/appearances',
  '/api/v1/user/search/account',
  '/api/v1/user/vip-levels',
]);
export const DYNAMIC_ROUTE_TEMPLATES = [
  '/api/v1/admin/memberships/users/:id/grants',
  '/api/v1/admin/avatar-frames/grants/:grantId/revoke',
  '/api/v1/admin/avatar-frames/users/:userId',
  '/api/v1/admin/avatar-frames/users/:userId/grants',
  '/api/v1/admin/friend-reports/:reportId/review',
  '/api/v1/admin/community/circles/:id/disable',
  '/api/v1/admin/community/circles/:id/restore',
  '/api/v1/admin/community/groups/:groupID/operations',
  '/api/v1/admin/mall/fancy-numbers/:id/status',
  '/api/v1/admin/mall/fancy-numbers/recommendations/:id',
  '/api/v1/admin/moderation/group-reports/:reportId/review',
  '/api/v1/admin/moderation/post-reports/:reportId/review',
  '/api/v1/admin/moderation/posts/:postId/restore',
  '/api/v1/admin/moderation/posts/:postId/takedown',
  '/api/v1/admin/support/recharge/orders/:id/approve',
  '/api/v1/admin/support/recharge/orders/:id/reject',
  '/api/v1/admin/support/recharge/payment-codes/:id',
  '/api/v1/admin/support/recharge/payment-codes/:id/enabled',
  '/api/v1/admin/users/:id',
  '/api/v1/admin/users/:id/audit-logs',
  '/api/v1/admin/users/:id/sensitive-access',
  '/api/v1/admin/users/:id/status',
  '/api/v1/auth/sessions/:sessionId',
  '/api/v1/calls/:callId/accept',
  '/api/v1/calls/:callId/cancel',
  '/api/v1/calls/:callId/join-token',
  '/api/v1/calls/:callId/leave',
  '/api/v1/calls/:callId/reject',
  '/api/v1/chat/conversations/:id/avatar',
  '/api/v1/chat/conversations/:id/burn',
  '/api/v1/chat/conversations/:id/clear',
  '/api/v1/chat/conversations/:id/dissolve',
  '/api/v1/chat/conversations/:id/events',
  '/api/v1/chat/conversations/:id/leave',
  '/api/v1/chat/conversations/:id/members',
  '/api/v1/chat/conversations/:id/members/:userId',
  '/api/v1/chat/conversations/:id/members/:userId/role',
  '/api/v1/chat/conversations/:id/members/:userId/silence',
  '/api/v1/chat/conversations/:id/message-days',
  '/api/v1/chat/conversations/:id/messages',
  '/api/v1/chat/conversations/:id/messages/:messageId/readers',
  '/api/v1/chat/conversations/:id/mute-all',
  '/api/v1/chat/conversations/:id/my-alias',
  '/api/v1/chat/conversations/:id/my-remark',
  '/api/v1/chat/conversations/:id/name',
  '/api/v1/chat/conversations/:id/notice',
  '/api/v1/chat/conversations/:id/owner',
  '/api/v1/chat/conversations/:id/policies',
  '/api/v1/chat/conversations/:id/preferences',
  '/api/v1/chat/conversations/:id/sync',
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
  '/api/v1/circle-invitation/:id/eligible-verifiers',
  '/api/v1/circle-invitation/:id/respond',
  '/api/v1/circle-invitation/circle/:circleId/pending',
  '/api/v1/circle-plaza/me/posts/:id/signups',
  '/api/v1/circle-plaza/me/posts/:id/signups/read',
  '/api/v1/circle-plaza/me/posts/:id/collaboration-recognitions',
  '/api/v1/circle-plaza/posts/:id',
  '/api/v1/circle-plaza/posts/:id/report',
  '/api/v1/circle-plaza/posts/:id/signup',
  '/api/v1/collections/:id',
  '/api/v1/conversation-groups/:id',
  '/api/v1/conversation-groups/:id/members',
  '/api/v1/friend/:friendUserId',
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
  '/api/v1/friend/requests/:requestId/messages',
  '/api/v1/friend/requests/:requestId/reject',
  '/api/v1/friend/status/:targetId',
  '/api/v1/friend/tags/:tagId',
  '/api/v1/friend/tags/:tagId/friends',
  '/api/v1/group/:groupID/leave',
  '/api/v1/group/:groupID/members/:userID',
  '/api/v1/group/:groupID/members/:userID/role',
  '/api/v1/group/:groupID/members/invite',
  '/api/v1/group/:groupID/report',
  '/api/v1/mall/fancy-numbers/:id/purchase',
  '/api/v1/mall/fancy-numbers/:id/switch',
  '/api/v1/note/:id',
  '/api/v1/note/:id/available',
  '/api/v1/note/:id/chat-media',
  '/api/v1/note/:id/exports',
  '/api/v1/note/:id/groups',
  '/api/v1/note/:id/pin',
  '/api/v1/note/:id/remark',
  '/api/v1/note/:id/restore',
  '/api/v1/note/:id/status',
  '/api/v1/note/group/:id',
  '/api/v1/note/share-links/:token',
  '/api/v1/notification/:id',
  '/api/v1/notification/:id/open-ownership',
  '/api/v1/notification/:id/read',
  '/api/v1/qr/tokens/:token',
  '/api/v1/qr/tokens/:token/join',
  '/api/v1/temp-chat/:id/end',
  '/api/v1/temp-chat/by-token/:token/join',
  '/api/v1/temp-chat/by-token/:token/meta',
  '/api/v1/temp-chat/guest/messages/:messageId/note',
  '/api/v1/trace/:id',
  '/api/v1/trace/:id/comment',
  '/api/v1/trace/:id/like',
  '/api/v1/trace/comment/:commentId',
  '/api/v1/user/:id',
  '/api/v1/user/:id/like',
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
