import { HttpException, HttpStatus } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { ErrorLoggingInterceptor } from './error-logging.interceptor';
import { runWithRequestContext } from '../logging/request-context';

describe('ErrorLoggingInterceptor', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      LOG_ON: 'true',
      SECURITY_LOG_ON: 'true',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('logs http errors with request context and rethrows them', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const interceptor = new ErrorLoggingInterceptor(logger as any);
    const error = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    const context = {} as any;
    const next = {
      handle: () => throwError(() => error),
    };

    await expect(
      runWithRequestContext(
        {
          requestId: 'req-1',
          traceId: 'req-1',
          method: 'POST',
          path: '/api/v1/secure',
          ip: '127.0.0.1',
          userAgent: 'jest',
          userId: 'user-1',
        },
        () => lastValueFrom(interceptor.intercept(context, next)),
      ),
    ).rejects.toBe(error);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http_error',
        requestId: 'req-1',
        method: 'POST',
        path: '/api/v1/secure',
        userId: 'user-1',
        statusCode: 403,
        errorName: 'HttpException',
      }),
      expect.any(String),
      'HttpError',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security_event',
        securityEvent: 'access_forbidden',
        statusCode: 403,
      }),
      'SecurityEvent',
    );
  });
});
