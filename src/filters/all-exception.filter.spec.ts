import {
  ArgumentsHost,
  ForbiddenException,
  LoggerService,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionFilter } from './all-exception.filter';
import { runWithRequestContext } from '../logging/request-context';
import {
  markErrorCaptured,
  markSecurityEventLogged,
} from '../logging/handled-errors';

function createFilter() {
  const logger: jest.Mocked<LoggerService> = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
  const reply = jest.fn();
  const httpAdapterHost = {
    httpAdapter: { reply },
  } as unknown as HttpAdapterHost;
  const filter = new AllExceptionFilter(logger, httpAdapterHost);
  return { filter, logger, reply };
}

function hostFor(request: Record<string, unknown>): ArgumentsHost {
  const response = { res: true };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionFilter', () => {
  it('logs the authenticated userId from req.user.userId, not req.user.id', () => {
    const { filter, logger } = createFilter();
    const host = hostFor({
      method: 'GET',
      url: '/api/v1/chat-history/conversations/si_a_b/messages',
      headers: {},
      query: {},
      user: { userId: 'user-123' },
    });

    filter.catch(new ForbiddenException('nope'), host);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, payload] = logger.warn.mock.calls[0] as [
      string,
      { userId?: string },
    ];
    expect(payload.userId).toBe('user-123');
  });

  it('returns the normalized error envelope with the right status', () => {
    const { filter, reply } = createFilter();
    const host = hostFor({
      method: 'GET',
      url: '/x',
      headers: {},
      query: {},
      user: { userId: 'user-123' },
    });

    filter.catch(new ForbiddenException('nope'), host);

    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      { code: 403, message: 'nope', data: null },
      403,
    );
  });

  it('surfaces a stable errorCode from the exception body into the envelope', () => {
    const { filter, reply } = createFilter();
    const host = hostFor({
      method: 'POST',
      url: '/auth/login',
      headers: {},
      query: {},
    });

    filter.catch(
      new ForbiddenException({
        message: '邮箱或密码错误',
        errorCode: 'AUTH_INVALID_CREDENTIALS',
      }),
      host,
    );

    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      {
        code: 403,
        message: '邮箱或密码错误',
        data: null,
        errorCode: 'AUTH_INVALID_CREDENTIALS',
      },
      403,
    );
  });

  it('surfaces structured details from the exception body into data', () => {
    const { filter, reply } = createFilter();
    const host = hostFor({
      method: 'GET',
      url: '/circle-plaza/posts/p1',
      headers: {},
      query: {},
    });

    filter.catch(
      new ForbiddenException({
        message: 'You are not a member of this circle',
        errorCode: 'PLAZA_NOT_CIRCLE_MEMBER',
        details: { circleId: 'c1', circleName: 'Board games' },
      }),
      host,
    );

    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      {
        code: 403,
        message: 'You are not a member of this circle',
        data: { circleId: 'c1', circleName: 'Board games' },
        errorCode: 'PLAZA_NOT_CIRCLE_MEMBER',
      },
      403,
    );
  });

  it('omits errorCode for plain exceptions', () => {
    const { filter, reply } = createFilter();
    const host = hostFor({ method: 'GET', url: '/x', headers: {}, query: {} });

    filter.catch(new ForbiddenException('nope'), host);

    const [, body] = reply.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(body).not.toHaveProperty('errorCode');
  });
});

describe('AllExceptionFilter error aggregation & security events', () => {
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

  function createFilterWithAggregation() {
    const logger = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    };
    const reply = jest.fn();
    const aggregation = {
      name: 'sentry' as const,
      captureError: jest.fn(),
      flush: jest.fn().mockResolvedValue(true),
    };
    const filter = new AllExceptionFilter(
      logger as unknown as LoggerService,
      { httpAdapter: { reply } } as unknown as HttpAdapterHost,
      aggregation,
    );
    return { filter, logger, reply, aggregation };
  }

  const request = {
    method: 'GET',
    url: '/api/v1/secure?x=1',
    headers: {},
    query: {},
  };

  it('forwards a 5xx raised outside the interceptor (guard / pipe) with request context', () => {
    const { filter, aggregation } = createFilterWithAggregation();
    const error = new Error('database exploded');

    runWithRequestContext(
      {
        requestId: 'req-9',
        traceId: 'req-9',
        method: 'GET',
        path: '/api/v1/secure',
        userId: 'user-9',
      },
      () => filter.catch(error, hostFor(request)),
    );

    expect(aggregation.captureError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        statusCode: 500,
        requestId: 'req-9',
        method: 'GET',
        path: '/api/v1/secure',
        userId: 'user-9',
      }),
    );
  });

  it('falls back to the raw request when no request context is active', () => {
    const { filter, aggregation } = createFilterWithAggregation();

    filter.catch(
      new Error('boom'),
      hostFor({ ...request, user: { userId: 'u-1' } }),
    );

    expect(aggregation.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/secure',
        userId: 'u-1',
      }),
    );
  });

  it('does not re-report an error the interceptor already captured', () => {
    const { filter, aggregation } = createFilterWithAggregation();
    const error = new Error('already captured');
    markErrorCaptured(error);

    filter.catch(error, hostFor(request));

    expect(aggregation.captureError).not.toHaveBeenCalled();
  });

  it('never forwards expected 4xx errors', () => {
    const { filter, aggregation } = createFilterWithAggregation();

    filter.catch(new ForbiddenException('nope'), hostFor(request));

    expect(aggregation.captureError).not.toHaveBeenCalled();
  });

  it('still replies when the aggregation SDK throws', () => {
    const { filter, reply, logger, aggregation } =
      createFilterWithAggregation();
    aggregation.captureError.mockImplementation(() => {
      throw new Error('sentry down');
    });

    filter.catch(new Error('boom'), hostFor(request));

    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 500 }),
      500,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'error_aggregation_failed' }),
      'HttpError',
    );
  });

  it('logs a security event for a guard-raised 401 and skips ones the interceptor logged', () => {
    const { filter, logger } = createFilterWithAggregation();

    filter.catch(
      new UnauthorizedException('Session revoked'),
      hostFor(request),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security_event',
        securityEvent: 'auth_unauthorized',
        statusCode: 401,
        reason: 'Session revoked',
      }),
      'SecurityEvent',
    );

    logger.warn.mockClear();
    const alreadyLogged = new ForbiddenException('handled upstream');
    markSecurityEventLogged(alreadyLogged);
    filter.catch(alreadyLogged, hostFor(request));

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security_event' }),
      'SecurityEvent',
    );
  });
});
