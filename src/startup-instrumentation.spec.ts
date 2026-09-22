describe('startup instrumentation', () => {
  beforeEach(() => jest.resetModules());

  it('initializes one provider and gives process.env precedence over file config', () => {
    const createProvider = jest.fn((config: Record<string, unknown>) => ({
      name: 'none',
      captureError: jest.fn(),
      flush: jest.fn(),
      config,
    }));
    jest.doMock('./config/server.config', () => ({
      getServerConfig: () => ({
        LOG_AGGREGATION_PROVIDER: 'sentry',
        SENTRY_DSN: 'file-dsn',
      }),
    }));
    jest.doMock('./logging/error-aggregation.service', () => ({
      createErrorAggregationConfig: jest.fn((raw) => raw),
      createErrorAggregationProvider: createProvider,
      configureErrorAggregationProvider: jest.fn(),
    }));
    jest.doMock('./logging/unhandled-rejection-guard', () => ({
      installUnhandledRejectionGuard: jest.fn(),
    }));
    process.env.LOG_AGGREGATION_PROVIDER = 'none';

    const instrumentation = jest.requireActual<
      typeof import('./startup-instrumentation')
    >('./startup-instrumentation');
    const first = instrumentation.getStartupErrorAggregation();
    const second = instrumentation.getStartupErrorAggregation();

    expect(first).toBe(second);
    expect(createProvider).toHaveBeenCalledTimes(1);
    const config = createProvider.mock.calls[0]![0];
    expect(config.LOG_AGGREGATION_PROVIDER).toBe('none');
    delete process.env.LOG_AGGREGATION_PROVIDER;
  });
});
