import {
  NoopErrorAggregationProvider,
  SentryErrorAggregationProvider,
  createErrorAggregationConfig,
  createErrorAggregationProvider,
  type SentryClientLike,
} from './error-aggregation.service';

function createFakeClient(): jest.Mocked<SentryClientLike> {
  return {
    captureException: jest.fn().mockReturnValue('event-id'),
    flush: jest.fn().mockResolvedValue(true),
  };
}

describe('createErrorAggregationConfig', () => {
  it('defaults to the none provider when nothing is configured', () => {
    const config = createErrorAggregationConfig({}, 'development');

    expect(config).toEqual({
      provider: 'none',
      dsn: undefined,
      environment: 'development',
      release: undefined,
    });
  });

  it('parses the sentry provider with dsn, environment and release', () => {
    const config = createErrorAggregationConfig(
      {
        LOG_AGGREGATION_PROVIDER: 'sentry',
        SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1',
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_RELEASE: 'circle-be@1.2.3',
      },
      'production',
    );

    expect(config).toEqual({
      provider: 'sentry',
      dsn: 'https://public@o0.ingest.sentry.io/1',
      environment: 'staging',
      release: 'circle-be@1.2.3',
    });
  });

  it('falls back to NODE_ENV for environment and trims the dsn', () => {
    const config = createErrorAggregationConfig(
      { LOG_AGGREGATION_PROVIDER: 'sentry', SENTRY_DSN: '  https://x@o/2  ' },
      'production',
    );

    expect(config.environment).toBe('production');
    expect(config.dsn).toBe('https://x@o/2');
  });

  it('treats an unknown provider as none', () => {
    const config = createErrorAggregationConfig(
      { LOG_AGGREGATION_PROVIDER: 'datadog' },
      'development',
    );

    expect(config.provider).toBe('none');
  });
});

describe('createErrorAggregationProvider', () => {
  it('returns a no-op provider when the provider is none', () => {
    const clientFactory = jest.fn();
    const provider = createErrorAggregationProvider(
      { provider: 'none', environment: 'development' },
      clientFactory,
    );

    expect(provider.name).toBe('none');
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('returns a no-op provider when sentry is selected but no dsn is present', () => {
    const clientFactory = jest.fn();
    const provider = createErrorAggregationProvider(
      { provider: 'sentry', environment: 'production' },
      clientFactory,
    );

    expect(provider.name).toBe('none');
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('falls back to no-op when the sentry client cannot be created', () => {
    const provider = createErrorAggregationProvider(
      { provider: 'sentry', dsn: 'https://x@o/1', environment: 'production' },
      () => undefined,
    );

    expect(provider.name).toBe('none');
  });

  it('builds a sentry provider with the resolved config when dsn is present', () => {
    const client = createFakeClient();
    const clientFactory = jest.fn().mockReturnValue(client);
    const config = {
      provider: 'sentry' as const,
      dsn: 'https://x@o/1',
      environment: 'production',
    };

    const provider = createErrorAggregationProvider(config, clientFactory);

    expect(provider.name).toBe('sentry');
    expect(clientFactory).toHaveBeenCalledWith(config);
  });
});

describe('SentryErrorAggregationProvider', () => {
  it('captures server errors with sanitized request tags and user id', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);
    const error = new Error('boom');

    provider.captureError(error, {
      statusCode: 500,
      requestId: 'req-1',
      traceId: 'trace-1',
      method: 'POST',
      path: '/api/v1/circle',
      userId: 'user-1',
    });

    expect(client.captureException).toHaveBeenCalledTimes(1);
    expect(client.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: expect.objectContaining({
          requestId: 'req-1',
          traceId: 'trace-1',
          method: 'POST',
          path: '/api/v1/circle',
          statusCode: '500',
        }),
        user: { id: 'user-1' },
      }),
    );
  });

  it('normalizes the path tag so link tokens and ids never reach Sentry', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    provider.captureError(new Error('boom'), {
      statusCode: 500,
      path: '/api/v1/temp-chat/by-token/eyJhbGciOiJIUzI1NiJ9.secret.sig/join',
    });

    const [, captureContext] = client.captureException.mock.calls[0];
    expect(captureContext.tags.path).toBe(
      '/api/v1/temp-chat/by-token/:token/join',
    );
    expect(captureContext.tags.path).not.toContain('secret');
  });

  it('collapses id segments in the path tag (bounds Sentry tag cardinality)', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    provider.captureError(new Error('boom'), {
      statusCode: 500,
      path: '/api/v1/circle/3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    const [, captureContext] = client.captureException.mock.calls[0];
    expect(captureContext.tags.path).toBe('/api/v1/circle/:id');
  });

  it('does not send expected 4xx client errors', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    provider.captureError(new Error('not found'), { statusCode: 404 });
    provider.captureError(new Error('unauthorized'), { statusCode: 401 });

    expect(client.captureException).not.toHaveBeenCalled();
  });

  it('omits empty tags and user when context is sparse', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    provider.captureError(new Error('boom'), { statusCode: 503 });

    const [, captureContext] = client.captureException.mock.calls[0];
    expect(captureContext).toEqual({ tags: { statusCode: '503' } });
    expect(captureContext).not.toHaveProperty('user');
  });

  it('delegates flush to the underlying client', async () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    await expect(provider.flush(2000)).resolves.toBe(true);
    expect(client.flush).toHaveBeenCalledWith(2000);
  });
});

describe('NoopErrorAggregationProvider', () => {
  it('never throws and reports a resolved flush', async () => {
    const provider = new NoopErrorAggregationProvider();

    expect(() =>
      provider.captureError(new Error('x'), { statusCode: 500 }),
    ).not.toThrow();
    await expect(provider.flush()).resolves.toBe(true);
  });
});
