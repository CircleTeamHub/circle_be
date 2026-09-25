import {
  getRequestContext,
  resolveRequestId,
  runWithRequestContext,
  setRequestUserId,
} from './request-context';

describe('request context', () => {
  it('keeps request context across async boundaries', async () => {
    await runWithRequestContext(
      {
        requestId: 'req-1',
        traceId: 'req-1',
        method: 'GET',
        path: '/api/v1/user',
        ip: '127.0.0.1',
        userAgent: 'jest',
      },
      async () => {
        await Promise.resolve();
        setRequestUserId('user-1');

        expect(getRequestContext()).toMatchObject({
          requestId: 'req-1',
          userId: 'user-1',
        });
      },
    );
  });

  it('returns undefined outside a request context', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('reuses only UUID incoming request ids and normalizes their case', () => {
    expect(resolveRequestId('9B2A7F3C-2A9E-4F1C-8D2B-124A5CC93A10')).toBe(
      '9b2a7f3c-2a9e-4f1c-8d2b-124a5cc93a10',
    );
  });

  it('generates ids for missing or unsafe incoming values', () => {
    const generated =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const unsafe of [
      undefined,
      'bad value with spaces',
      'eyJhbGciOiJIUzI1NiJ9..c2lnbmF0dXJl',
      'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.',
      'protected..iv.ciphertext.tag',
      'person@example.com',
      'edge:01JABC.def',
      'privateaccount123',
      '15551234567',
      '00000000-0000-0000-0000-000000000000',
    ])
      expect(resolveRequestId(unsafe)).toMatch(generated);
  });
});
