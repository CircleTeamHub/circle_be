import {
  OTHER_ROUTE,
  limitRouteCardinality,
} from '../metrics/route-normalizer';
import {
  NoopErrorAggregationProvider,
  SentryErrorAggregationProvider,
  configureErrorAggregationProvider,
  createErrorAggregationConfig,
  createErrorAggregationProvider,
  createSentryInitOptions,
  reportOperationalError,
  type ErrorAggregationProvider,
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
      expect.objectContaining({ message: 'http server error' }),
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
    expect(client.captureException.mock.calls[0]?.[0]).not.toBe(error);
  });

  it('sanitizes secrets and PII from captured exception messages and stacks', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);
    const error = new Error(
      'private chat says blue pineapple for person@example.test with Bearer top-secret at https://store.test/object?X-Amz-Signature=secret',
    );
    error.stack = `${error.message}\n at eyJheader.payload.signature`;

    provider.captureError(error, { statusCode: 500 });

    const captured = client.captureException.mock.calls[0]?.[0] as Error;
    expect(captured).not.toBe(error);
    expect(`${captured.message}\n${captured.stack}`).not.toMatch(
      /blue pineapple|person@example\.test|top-secret|X-Amz-Signature|eyJheader\.payload\.signature/,
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

  it('bounds distinct unknown path tags so drifted routes cannot explode tag cardinality', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    // A route the normalizer has no template for is returned verbatim, so every
    // distinct token becomes its own indexed, retained Sentry tag value. Route
    // drift is real (PR #64) and case-permuted paths bypass template matching
    // entirely, so the tag budget cannot rely on the template list being exact.
    for (let index = 0; index < 500; index += 1) {
      provider.captureError(new Error('boom'), {
        statusCode: 500,
        path: `/api/v1/drifted/token-${index}`,
      });
    }

    const pathTags = new Set(
      client.captureException.mock.calls.map((call) => call[1]?.tags?.path),
    );

    // 200 unknown-route budget + the /__other__ bucket everything else folds into.
    expect(pathTags.size).toBeLessThanOrEqual(201);
    expect(pathTags.has(OTHER_ROUTE)).toBe(true);
  });

  it('still reports known routes verbatim after the unknown-path budget is spent', () => {
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    for (let index = 0; index < 500; index += 1) {
      provider.captureError(new Error('boom'), {
        statusCode: 500,
        path: `/api/v1/drifted/token-${index}`,
      });
    }
    provider.captureError(new Error('boom'), {
      statusCode: 500,
      path: '/api/v1/circle/3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    const { calls } = client.captureException.mock;
    expect(calls[calls.length - 1]?.[1]?.tags?.path).toBe('/api/v1/circle/:id');
  });

  it('keeps a budget independent of the app-wide metrics limiter', () => {
    // The HTTP middleware's limiter sees every request, including 404 scans, so
    // its 200-slot unknown budget is the first thing an attacker exhausts.
    // Sharing it would bucket the first genuine 5xx on a drifted route into
    // /__other__ — losing the path exactly when Sentry needs it most.
    for (let index = 0; index < 250; index += 1) {
      limitRouteCardinality(`/api/v1/scan-${index}`);
    }
    const client = createFakeClient();
    const provider = new SentryErrorAggregationProvider(client);

    provider.captureError(new Error('boom'), {
      statusCode: 500,
      path: '/api/v1/drifted/first-real-5xx',
    });

    const [, captureContext] = client.captureException.mock.calls[0];
    expect(captureContext?.tags?.path).toBe('/api/v1/drifted/first-real-5xx');
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

describe('reportOperationalError', () => {
  afterEach(() => {
    configureErrorAggregationProvider(new NoopErrorAggregationProvider());
  });

  it('routes non-HTTP failures through the configured provider with stable tags', () => {
    const provider: ErrorAggregationProvider = {
      name: 'sentry',
      captureError: jest.fn(),
      flush: jest.fn().mockResolvedValue(true),
    };
    configureErrorAggregationProvider(provider);

    reportOperationalError(new Error('db down'), {
      component: 'CallCleanup',
      operation: 'sweepExpiredRingingCalls',
      kind: 'scheduler',
    });

    expect(provider.captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'CallCleanup.sweepExpiredRingingCalls failure',
      }),
      {
        component: 'CallCleanup',
        operation: 'sweepExpiredRingingCalls',
        kind: 'scheduler',
      },
    );
  });

  it('deduplicates repeated operational failures so outages do not flood Sentry', () => {
    const provider: ErrorAggregationProvider = {
      name: 'sentry',
      captureError: jest.fn(),
      flush: jest.fn().mockResolvedValue(true),
    };
    configureErrorAggregationProvider(provider);
    const context = {
      component: 'RealtimeGateway',
      operation: 'emitSnapshot',
      kind: 'websocket',
    };

    reportOperationalError(new Error('first'), context);
    reportOperationalError(new Error('second'), context);

    expect(provider.captureError).toHaveBeenCalledTimes(1);
  });
});

describe('createSentryInitOptions', () => {
  it('disables automatic integrations and applies a final privacy filter', () => {
    const options = createSentryInitOptions({
      provider: 'sentry',
      dsn: 'https://a@o/1',
      environment: 'production',
      release: 'circle-be@abc',
    });

    expect(options).toEqual(
      expect.objectContaining({
        sendDefaultPii: false,
        defaultIntegrations: false,
        tracesSampleRate: 0,
      }),
    );
    expect(typeof options.beforeSend).toBe('function');
    const filtered = (options.beforeSend as (event: unknown) => unknown)({
      exception: {
        values: [
          {
            type: 'Error',
            value: 'private blue pineapple',
            stacktrace: {
              frames: [
                {
                  filename: 'src/chat.ts',
                  function: 'send',
                  lineno: 42,
                  vars: { message: 'private blue pineapple' },
                  context_line: 'const message = privateContent',
                },
              ],
            },
          },
        ],
      },
      request: { headers: { authorization: 'Bearer secret' } },
    }) as Record<string, any>;
    expect(JSON.stringify(filtered)).not.toMatch(
      /blue pineapple|Bearer secret/,
    );
    expect(filtered.exception.values[0].stacktrace.frames).toEqual([
      {
        filename: 'src/chat.ts',
        function: 'send',
        lineno: 42,
      },
    ]);
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
