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
const STATIC_ROUTES = new Set([
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
const DYNAMIC_ROUTE_TEMPLATES = [
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

export function normalizeRoute(path: string): string {
  if (!path) {
    return '/';
  }

  const rawPathname = path.split('?')[0];
  if (rawPathname === '' || rawPathname === '/') {
    return '/';
  }
  const pathname =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  if (STATIC_ROUTES.has(pathname)) {
    return pathname;
  }

  const pathSegments = pathname.split('/');
  const matchedTemplate = DYNAMIC_ROUTE_TEMPLATES.find((template) =>
    matchesTemplate(pathSegments, template),
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
