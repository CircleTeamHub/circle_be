import { HttpException, HttpStatus } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { ErrorLoggingInterceptor } from './error-logging.interceptor';
import { runWithRequestContext } from '../logging/request-context';
import type { ErrorAggregationProvider } from '../logging/error-aggregation.service';
import { Prisma } from 'src/generated/prisma';
import {
  wasErrorCaptured,
  wasSecurityEventLogged,
} from '../logging/handled-errors';

function createAggregationSpy(): ErrorAggregationProvider {
  return {
    name: 'sentry',
    captureError: jest.fn(),
    flush: jest.fn().mockResolvedValue(true),
  };
}

const requestContext = {
  requestId: 'req-1',
  traceId: 'req-1',
  method: 'POST',
  path: '/api/v1/secure',
  ip: '127.0.0.1',
  userAgent: 'jest',
  userId: 'user-1',
};

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

  it('forwards unexpected 5xx errors to error aggregation with request context', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const aggregation = createAggregationSpy();
    const interceptor = new ErrorLoggingInterceptor(logger as any, aggregation);
    const error = new Error('database exploded');
    const next = { handle: () => throwError(() => error) };

    await expect(
      runWithRequestContext(requestContext, () =>
        lastValueFrom(interceptor.intercept({} as any, next)),
      ),
    ).rejects.toBe(error);

    expect(aggregation.captureError).toHaveBeenCalledTimes(1);
    expect(aggregation.captureError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        statusCode: 500,
        requestId: 'req-1',
        method: 'POST',
        path: '/api/v1/secure',
        userId: 'user-1',
      }),
    );
  });

  it('still propagates the original error when aggregation.captureError throws', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const aggregation = createAggregationSpy();
    (aggregation.captureError as jest.Mock).mockImplementation(() => {
      throw new Error('sentry SDK blew up');
    });
    const interceptor = new ErrorLoggingInterceptor(logger as any, aggregation);
    const error = new Error('database exploded');
    const next = { handle: () => throwError(() => error) };

    // The ORIGINAL error must reach the caller, not the telemetry error.
    await expect(
      runWithRequestContext(requestContext, () =>
        lastValueFrom(interceptor.intercept({} as any, next)),
      ),
    ).rejects.toBe(error);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'error_aggregation_failed' }),
      'HttpError',
    );
  });

  it('still propagates the original error when the security logger throws', async () => {
    const logger = {
      error: jest.fn(),
      warn: jest.fn(() => {
        throw new Error('transport down');
      }),
    };
    const interceptor = new ErrorLoggingInterceptor(logger as any);
    const error = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    const next = { handle: () => throwError(() => error) };

    await expect(
      runWithRequestContext(requestContext, () =>
        lastValueFrom(interceptor.intercept({} as any, next)),
      ),
    ).rejects.toBe(error);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security_event_log_failed',
        requestId: 'req-1',
        message: 'transport down',
      }),
      'HttpError',
    );
    // Nothing was logged, so the filter must still be allowed to try.
    expect(wasSecurityEventLogged(error)).toBe(false);
  });

  it('does not forward expected 4xx errors to error aggregation', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const aggregation = createAggregationSpy();
    const interceptor = new ErrorLoggingInterceptor(logger as any, aggregation);
    const error = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    const next = { handle: () => throwError(() => error) };

    await expect(
      runWithRequestContext(requestContext, () =>
        lastValueFrom(interceptor.intercept({} as any, next)),
      ),
    ).rejects.toBe(error);

    expect(aggregation.captureError).not.toHaveBeenCalled();
  });

  it('works without an aggregation provider (optional dependency)', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const interceptor = new ErrorLoggingInterceptor(logger as any);
    const error = new Error('boom');
    const next = { handle: () => throwError(() => error) };

    await expect(
      runWithRequestContext(requestContext, () =>
        lastValueFrom(interceptor.intercept({} as any, next)),
      ),
    ).rejects.toBe(error);

    expect(logger.error).toHaveBeenCalled();
  });
});

describe('ErrorLoggingInterceptor status mapping & handled-error markers', () => {
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

  it('treats a unique-constraint race (P2002) as an expected 409, not a server error', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const aggregation = createAggregationSpy();
    const interceptor = new ErrorLoggingInterceptor(logger as any, aggregation);
    const error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      { code: 'P2002', clientVersion: 'test' },
    );
    const next = { handle: () => throwError(() => error) };

    await expect(
      runWithRequestContext(requestContext, () =>
        lastValueFrom(interceptor.intercept({} as any, next)),
      ),
    ).rejects.toBe(error);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'http_error', statusCode: 409 }),
      expect.any(String),
      'HttpError',
    );
    expect(aggregation.captureError).not.toHaveBeenCalled();
  });

  it('still reports an unknown Prisma failure as a 500', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const aggregation = createAggregationSpy();
    const interceptor = new ErrorLoggingInterceptor(logger as any, aggregation);
    const error = new Prisma.PrismaClientKnownRequestError('connection lost', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const next = { handle: () => throwError(() => error) };

    await expect(
      runWithRequestContext(requestContext, () =>
        lastValueFrom(interceptor.intercept({} as any, next)),
      ),
    ).rejects.toBe(error);

    expect(aggregation.captureError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ statusCode: 500 }),
    );
  });

  it('marks forwarded 5xx errors and logged 401/403 so the filter does not repeat them', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const aggregation = createAggregationSpy();
    const interceptor = new ErrorLoggingInterceptor(logger as any, aggregation);
    const serverError = new Error('boom');
    const forbidden = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

    for (const error of [serverError, forbidden]) {
      await expect(
        runWithRequestContext(requestContext, () =>
          lastValueFrom(
            interceptor.intercept({} as any, {
              handle: () => throwError(() => error),
            }),
          ),
        ),
      ).rejects.toBe(error);
    }

    expect(wasErrorCaptured(serverError)).toBe(true);
    expect(wasErrorCaptured(forbidden)).toBe(false);
    expect(wasSecurityEventLogged(forbidden)).toBe(true);
    expect(wasSecurityEventLogged(serverError)).toBe(false);
  });
});
