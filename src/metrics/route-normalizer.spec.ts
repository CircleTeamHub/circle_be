import { normalizeRoute } from './route-normalizer';

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

  it('keeps non-id paths like /metrics intact', () => {
    expect(normalizeRoute('/metrics')).toBe('/metrics');
  });

  it('handles empty input defensively', () => {
    expect(normalizeRoute('')).toBe('/');
  });
});
