import { ResponseInterceptor } from './interceptors/response.interceptor';
import { setupApp } from './setup';

jest.mock('./config/server.config', () => ({
  getServerConfig: jest.fn(() => ({
    LOG_ON: 'false',
  })),
}));

describe('setupApp', () => {
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
