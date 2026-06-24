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
});
