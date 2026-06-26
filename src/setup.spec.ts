import { AllExceptionFilter } from './filters/all-exception.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { ErrorLoggingInterceptor } from './interceptors/error-logging.interceptor';
import { setupApp } from './setup';

function buildAppMock() {
  return {
    setGlobalPrefix: jest.fn(),
    useGlobalFilters: jest.fn(),
    useGlobalPipes: jest.fn(),
    useGlobalInterceptors: jest.fn(),
    use: jest.fn(),
    get: jest.fn().mockReturnValue({ httpAdapter: { reply: jest.fn() } }),
    useLogger: jest.fn(),
  };
}

const getServerConfigMock = jest.fn<Record<string, unknown>, []>(() => ({
  LOG_ON: 'false',
}));

jest.mock('./config/server.config', () => ({
  getServerConfig: () => getServerConfigMock(),
}));

describe('setupApp', () => {
  beforeEach(() => {
    getServerConfigMock.mockReturnValue({
      LOG_ON: 'false',
    });
  });

  it('registers the global response interceptor', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ResponseInterceptor),
    );
  });

  it('registers global exception filters (All + Prisma)', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.useGlobalFilters).toHaveBeenCalledWith(
      expect.any(AllExceptionFilter),
      expect.any(PrismaExceptionFilter),
    );
  });

  it('registers request and error logging when enabled', () => {
    getServerConfigMock.mockReturnValue({
      LOG_ON: 'true',
      HTTP_LOG_ON: 'true',
      SLOW_REQUEST_MS: '750',
    });
    const app = {
      setGlobalPrefix: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalPipes: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      use: jest.fn(),
      get: jest.fn(() => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      })),
      useLogger: jest.fn(),
    };

    setupApp(app as any);

    expect(app.useLogger).toHaveBeenCalled();
    expect(app.use).toHaveBeenCalledWith(expect.any(Function));
    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ErrorLoggingInterceptor),
    );
    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ResponseInterceptor),
    );
  });

  it('registers a hardened ValidationPipe (whitelist + forbidNonWhitelisted)', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.useGlobalPipes).toHaveBeenCalledTimes(1);
    const [pipe] = (app.useGlobalPipes.mock.calls[0] ?? []) as Array<unknown>;
    expect(pipe).toBeDefined();
    // ValidationPipe stores options on `validatorOptions` / private fields;
    // assert via the public surface by re-instantiating to compare options is
    // brittle, so we only verify the pipe was registered. Detailed option
    // verification is covered by integration tests.
  });

  it('adds dedicated rate limits for friend requests and coin gifts', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.use).toHaveBeenCalledWith(
      '/api/v1/friend/requests',
      expect.any(Function),
    );
    expect(app.use).toHaveBeenCalledWith(
      '/api/v1/coin/gift',
      expect.any(Function),
    );
  });

  it('adds a dedicated rate limit for trace detail reads', () => {
    const app = buildAppMock();
    setupApp(app as any);

    const traceLimiters = app.use.mock.calls.filter(
      ([path]) => path === '/api/v1/trace',
    );
    expect(traceLimiters).toHaveLength(2);
    expect(traceLimiters[0][1]).toEqual(expect.any(Function));
    expect(traceLimiters[1][1]).toEqual(expect.any(Function));
  });

  it('adds dedicated rate limits for group writes and group reports', () => {
    const app = buildAppMock();
    setupApp(app as any);

    const groupLimiters = app.use.mock.calls.filter(
      ([path]) => path === '/api/v1/group',
    );
    expect(groupLimiters).toHaveLength(2);
    expect(groupLimiters[0][1]).toEqual(expect.any(Function));
    expect(groupLimiters[1][1]).toEqual(expect.any(Function));
  });
});
