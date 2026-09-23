import {
  SentryErrorAggregationProvider,
  createSentryInitOptions,
  sanitizeTransactionName,
} from './error-aggregation.service';
import { resolveRequestId } from './request-context';

describe('aggregation privacy at unregistered route boundaries', () => {
  it('normalizes automatic Sentry event path tags as strictly as explicit reports', () => {
    const options = createSentryInitOptions({
      provider: 'sentry',
      environment: 'test',
    });
    const beforeSend = options.beforeSend as (event: unknown) => any;
    expect(
      beforeSend({ tags: { path: '/api/v1/unknown/private-link' } }).tags.path,
    ).toBe('/__other__');
  });
  it('never sends the first unknown secret path to Sentry', () => {
    const client = { captureException: jest.fn(), flush: jest.fn() };
    new SentryErrorAggregationProvider(client).captureError(
      new Error('private'),
      { statusCode: 500, path: '/private-link-secret' },
    );
    expect(client.captureException.mock.calls[0][1].tags.path).toBe(
      '/__other__',
    );
    expect(sanitizeTransactionName('GET /unknown/private-link-secret')).toBe(
      'GET /__other__',
    );
  });

  it('replaces JWT-shaped incoming request ids before correlation', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
    expect(resolveRequestId(jwt)).not.toBe(jwt);
  });
});
