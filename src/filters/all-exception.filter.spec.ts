import {
  ArgumentsHost,
  ForbiddenException,
  LoggerService,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionFilter } from './all-exception.filter';

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
