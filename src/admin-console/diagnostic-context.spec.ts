import { diagnosticCause, diagnosticContext } from './diagnostic-context';

describe('safe diagnostic context', () => {
  it('returns only registered routes, methods and classified causes', () => {
    expect(
      diagnosticContext({
        route: '/api/v1/admin/console/tasks',
        method: 'GET',
        failureCause: 'DATABASE_QUERY_INVALID',
        token: 'private',
        message: 'secret',
      }),
    ).toEqual({
      requestRoute: '/api/v1/admin/console/tasks',
      requestMethod: 'GET',
      failureCause: 'DATABASE_QUERY_INVALID',
    });
  });
  it.each([
    '/internal-secret',
    '/api/v1/admin/users/private-user-id',
    'https://evil.test/token',
    '/api/v1/admin/console/tasks?token=private',
  ])('does not expose arbitrary routes: %s', (route) => {
    expect(
      diagnosticContext({ route, method: 'secret', failureCause: 'private' }),
    ).toEqual({ requestRoute: null, requestMethod: null, failureCause: null });
  });
  it('categorizes Prisma errors without retaining their private error message', () => {
    const error = new Error('private SQL parameter or token');
    error.name = 'PrismaClientValidationError';
    expect(diagnosticCause(error, 500)).toBe('DATABASE_QUERY_INVALID');
    expect(diagnosticCause(new Error('private'), 500)).toBe('INTERNAL_ERROR');
  });
  it('canonicalizes declared parameter names without exposing concrete values', () => {
    expect(
      diagnosticContext({ route: '/api/v1/admin/users/:userId', method: 'GET' })
        .requestRoute,
    ).toBe('/api/v1/admin/users/:id');
  });
});
