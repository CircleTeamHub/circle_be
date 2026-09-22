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

  it('reuses safe incoming request ids', () => {
    expect(resolveRequestId('9B2A7F3C-2A9E-4F1C-8D2B-124A5CC93A10')).toBe(
      '9b2a7f3c-2a9e-4f1c-8d2b-124a5cc93a10',
    );
  });

  it('generates ids for missing or unsafe incoming values', () => {
    expect(resolveRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(resolveRequestId('bad value with spaces')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(resolveRequestId('part1.part2.part3')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(resolveRequestId('privateaccount123')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(resolveRequestId('15551234567')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
