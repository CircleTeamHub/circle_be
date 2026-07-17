import {
  normalizeRoute,
  createRouteCardinalityLimiter,
  OTHER_ROUTE,
  STATIC_ROUTES,
  DYNAMIC_ROUTE_TEMPLATES,
} from './route-normalizer';

describe('normalizeRoute', () => {
  it('collapses UUID segments to :id (prevents cardinality explosion)', () => {
    expect(
      normalizeRoute('/api/v1/circle/3fa85f64-5717-4562-b3fc-2c963f66afa6'),
    ).toBe('/api/v1/circle/:id');
  });

  it('collapses Mongo ObjectId (24-hex) segments to :id', () => {
    expect(normalizeRoute('/api/v1/trace/507f1f77bcf86cd799439011')).toBe(
      '/api/v1/trace/:id',
    );
  });

  it('collapses numeric id segments to :id', () => {
    expect(normalizeRoute('/api/v1/user/12345')).toBe('/api/v1/user/:id');
  });

  it('collapses multiple dynamic segments independently', () => {
    expect(normalizeRoute('/api/v1/circle/42/members/99')).toBe(
      '/api/v1/circle/:id/members/:id',
    );
  });

  it('collapses temp-chat link tokens instead of exposing them as metric labels', () => {
    expect(
      normalizeRoute(
        '/api/v1/temp-chat/by-token/eyJhbGciOiJIUzI1NiJ9.secret.signature/meta',
      ),
    ).toBe('/api/v1/temp-chat/by-token/:token/meta');
    expect(
      normalizeRoute(
        '/api/v1/temp-chat/by-token/eyJhbGciOiJIUzI1NiJ9.secret.signature/join',
      ),
    ).toBe('/api/v1/temp-chat/by-token/:token/join');
  });

  it('matches case-insensitively so link tokens cannot escape redaction', () => {
    // Express routing is case-insensitive by default, so this path reaches the
    // real handler — but an exact-case template match misses it and falls back
    // to returning the raw token verbatim.
    expect(
      normalizeRoute(
        '/API/V1/temp-chat/by-token/eyJhbGciOiJIUzI1NiJ9.secret.signature/join',
      ),
    ).toBe('/api/v1/temp-chat/by-token/:token/join');
  });

  it('maps case-permuted spellings of one route to a single canonical label', () => {
    const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    expect(normalizeRoute(`/API/V1/CiRcLe/${uuid}`)).toBe('/api/v1/circle/:id');
    expect(normalizeRoute(`/Api/V1/circle/${uuid}`)).toBe('/api/v1/circle/:id');
    expect(normalizeRoute('/API/V1/AUTH/LOGIN')).toBe('/api/v1/auth/login');
  });

  it('canonicalizes case for unlisted paths so permutations share one label', () => {
    expect(normalizeRoute('/api/v1/UnListed/Path')).toBe(
      '/api/v1/unlisted/path',
    );
  });

  it('collapses note share-link tokens instead of exposing them as metric labels', () => {
    // randomBytes(18).toString('base64url') — matches none of the id-collapse
    // fallback regexes, so only the template keeps it out of the label.
    expect(
      normalizeRoute('/api/v1/note/share-links/EjXL-ytbFWx0_u4Qn4zymT5g'),
    ).toBe('/api/v1/note/share-links/:token');
    // Same template also covers the revoke route, which passes the share link's
    // uuid in this position — `method` is a separate label, so one template is
    // enough to tell the two apart on a dashboard.
    expect(
      normalizeRoute(
        '/api/v1/note/share-links/3fa85f64-5717-4562-b3fc-2c963f66afa6',
      ),
    ).toBe('/api/v1/note/share-links/:token');
  });

  it('collapses OpenIM string ids used in group and chat-history routes', () => {
    expect(normalizeRoute('/api/v1/group/sg_group-1/members/user-2')).toBe(
      '/api/v1/group/:groupID/members/:userID',
    );
    expect(
      normalizeRoute(
        '/api/v1/chat-history/conversations/si_user-a_user-b/messages',
      ),
    ).toBe('/api/v1/chat-history/conversations/:conversationID/messages');
  });

  it('leaves fully static routes unchanged', () => {
    expect(normalizeRoute('/api/v1/auth/login')).toBe('/api/v1/auth/login');
    expect(normalizeRoute('/api/v1/auth/admin/login')).toBe(
      '/api/v1/auth/admin/login',
    );
    expect(normalizeRoute('/api/v1/auth/admin/refresh')).toBe(
      '/api/v1/auth/admin/refresh',
    );
    expect(STATIC_ROUTES.has('/api/v1/auth/admin/login')).toBe(true);
    expect(STATIC_ROUTES.has('/api/v1/auth/admin/refresh')).toBe(true);
  });

  it('strips the query string', () => {
    expect(normalizeRoute('/api/v1/trace/feed?authorId=abc&page=2')).toBe(
      '/api/v1/trace/feed',
    );
  });

  it('strips a trailing slash except for root', () => {
    expect(normalizeRoute('/api/v1/circle/')).toBe('/api/v1/circle');
    expect(normalizeRoute('/')).toBe('/');
  });

  it('prefers the more specific literal template over a same-length wildcard one', () => {
    // `/members/invite` must not be shadowed by `/members/:userID`.
    expect(normalizeRoute('/api/v1/group/sg_group-1/members/invite')).toBe(
      '/api/v1/group/:groupID/members/invite',
    );
    // A real userID still maps to the wildcard template.
    expect(normalizeRoute('/api/v1/group/sg_group-1/members/user-2')).toBe(
      '/api/v1/group/:groupID/members/:userID',
    );
  });

  it('keeps non-id paths like /metrics intact', () => {
    expect(normalizeRoute('/metrics')).toBe('/metrics');
  });

  it('handles empty input defensively', () => {
    expect(normalizeRoute('')).toBe('/');
  });
});

describe('createRouteCardinalityLimiter', () => {
  it('always admits known static and template routes', () => {
    const limit = createRouteCardinalityLimiter(0);
    expect(limit('/api/v1/auth/login')).toBe('/api/v1/auth/login');
    expect(limit('/api/v1/circle/:id')).toBe('/api/v1/circle/:id');
  });

  it('admits unknown routes up to the budget, then buckets the rest', () => {
    const limit = createRouteCardinalityLimiter(2);
    expect(limit('/api/v1/unknown-a')).toBe('/api/v1/unknown-a');
    expect(limit('/api/v1/unknown-b')).toBe('/api/v1/unknown-b');
    // budget (2) is now exhausted — any *new* unknown route collapses
    expect(limit('/api/v1/unknown-c')).toBe(OTHER_ROUTE);
    // already-seen unknown routes still pass through
    expect(limit('/api/v1/unknown-a')).toBe('/api/v1/unknown-a');
  });

  it('bounds cardinality under 404 scanning with random non-id segments', () => {
    const limit = createRouteCardinalityLimiter(50);
    const labels = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      labels.add(limit(`/api/v1/scan-${i}`));
    }
    // 50 distinct unknown labels + the OTHER bucket — not 10k series.
    expect(labels.size).toBeLessThanOrEqual(51);
    expect(labels.has(OTHER_ROUTE)).toBe(true);
  });
});

// Self-consistency guard for the hand-maintained route allowlists. Does not
// boot Nest (no DB/network), but catches the realistic drift failure modes:
// malformed entries, static/template overlap, and templates the matcher can't
// actually match.
describe('route allowlist consistency', () => {
  const staticRoutes = [...STATIC_ROUTES];

  it('has no path appearing in both the static set and the template list', () => {
    const overlap = DYNAMIC_ROUTE_TEMPLATES.filter((t) => STATIC_ROUTES.has(t));
    expect(overlap).toEqual([]);
  });

  it('static routes are well-formed and contain no :params', () => {
    for (const route of staticRoutes) {
      expect(route.startsWith('/api/v1/')).toBe(true);
      expect(route).not.toContain('/:');
      expect(route.endsWith('/')).toBe(false);
    }
  });

  // normalizeRoute lowercases the path before matching (Express routes are
  // case-insensitive), so an allowlist entry with an uppercase literal segment
  // could never match and would silently fall through to the id-collapse path.
  it('has only lowercase literal segments', () => {
    for (const route of staticRoutes) {
      expect(route).toBe(route.toLowerCase());
    }
    for (const template of DYNAMIC_ROUTE_TEMPLATES) {
      const literals = template
        .split('/')
        .filter((segment) => segment !== '' && !segment.startsWith(':'));
      for (const literal of literals) {
        expect(literal).toBe(literal.toLowerCase());
      }
    }
  });

  it('every static route normalizes to itself (is actually matchable)', () => {
    for (const route of staticRoutes) {
      expect(normalizeRoute(route)).toBe(route);
    }
  });

  it('every template has at least one :param and normalizes to itself', () => {
    for (const template of DYNAMIC_ROUTE_TEMPLATES) {
      expect(template.startsWith('/api/v1/')).toBe(true);
      expect(template).toContain('/:');
      expect(normalizeRoute(template)).toBe(template);
    }
  });

  it('every template matches a concrete (non-id) instance of itself', () => {
    for (const template of DYNAMIC_ROUTE_TEMPLATES) {
      // Replace each :param with a non-id token so a match can ONLY come from
      // the template matcher, never the id-collapse fallback.
      const concrete = template
        .split('/')
        .map((seg, i) => (seg.startsWith(':') ? `sample${i}` : seg))
        .join('/');
      expect(normalizeRoute(concrete)).toBe(template);
    }
  });
});
