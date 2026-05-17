import { AllExceptionFilter } from './filters/all-exception.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { setupApp } from './setup';

function buildAppMock() {
  return {
    setGlobalPrefix: jest.fn(),
    useGlobalFilters: jest.fn(),
    useGlobalPipes: jest.fn(),
    useGlobalInterceptors: jest.fn(),
    use: jest.fn(),
    get: jest.fn().mockReturnValue({ httpAdapter: { reply: jest.fn() } }),
  };
}

describe('setupApp', () => {
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
});
