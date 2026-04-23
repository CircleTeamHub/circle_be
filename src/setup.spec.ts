import { ResponseInterceptor } from './interceptors/response.interceptor';
import { ErrorLoggingInterceptor } from './interceptors/error-logging.interceptor';
import { setupApp } from './setup';

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
    const app = {
      setGlobalPrefix: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalPipes: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      use: jest.fn(),
      get: jest.fn(),
      useLogger: jest.fn(),
    };

    setupApp(app as any);

    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ResponseInterceptor),
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
      get: jest.fn(() => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() })),
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

  it('adds dedicated rate limits for friend requests and coin gifts', () => {
    const app = {
      setGlobalPrefix: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalPipes: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      use: jest.fn(),
      get: jest.fn(),
      useLogger: jest.fn(),
    };

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
});
