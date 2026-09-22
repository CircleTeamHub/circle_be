import { EventEmitter } from 'node:events';
import { ForbiddenException, Logger } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { createRequestLoggerMiddleware } from './request-logger.middleware';
import { getRequestContext, runWithRequestContext } from './request-context';
import { AllExceptionFilter } from '../filters/all-exception.filter';
import { ErrorLoggingInterceptor } from '../interceptors/error-logging.interceptor';
import { PrismaExceptionFilter } from '../filters/prisma-exception.filter';
import { Prisma } from 'src/generated/prisma';
import { logHttpFailure } from './http-failure.logger';

const TEST_REQUEST_ID = '9b2a7f3c-2a9e-4f1c-8d2b-124a5cc93a10';

function loggerSpy() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    setHeader: jest.fn(),
    getHeader: jest.fn(),
  });
}

const request = () => ({
  method: 'GET',
  originalUrl:
    '/api/v1/note/share-links/private-link?email=private@example.com',
  url: '/api/v1/note/share-links/private-link?email=private@example.com',
  headers: { 'x-request-id': TEST_REQUEST_ID, 'user-agent': 'private-device' },
  ip: '192.0.2.9',
  query: { email: 'private@example.com', content: 'private chat' },
});

function host(req: unknown, res: unknown = {}) {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as any;
}

describe('HTTP diagnostic privacy and reliability', () => {
  it('keeps correlation when access output is disabled', () => {
    const logger = loggerSpy();
    const res = response();
    const middleware = createRequestLoggerMiddleware(logger, {
      enabled: false,
      slowRequestMs: 1000,
    });
    middleware(request() as any, res as any, () => {
      expect(getRequestContext()).toMatchObject({
        requestId: TEST_REQUEST_ID,
        path: '/api/v1/note/share-links/:token',
      });
    });
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', TEST_REQUEST_ID);
    res.emit('finish');
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs one aborted terminal event without contact data or share tokens', () => {
    const logger = loggerSpy();
    const res = response();
    createRequestLoggerMiddleware(logger, {
      enabled: true,
      slowRequestMs: 1000,
    })(request() as any, res as any, jest.fn());
    res.emit('close');
    res.emit('finish');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http_aborted',
        requestId: TEST_REQUEST_ID,
        path: '/api/v1/note/share-links/:token',
      }),
      'HttpAccess',
    );
    expect(logger.log).not.toHaveBeenCalled();
    const output = JSON.stringify(logger.warn.mock.calls);
    for (const privateValue of [
      'private-link',
      'private@example.com',
      'private-device',
      '192.0.2.9',
    ])
      expect(output).not.toContain(privateValue);
  });

  it('does not double-log a normal finish followed by close', () => {
    const logger = loggerSpy();
    const res = response();
    createRequestLoggerMiddleware(logger, {
      enabled: true,
      slowRequestMs: 1000,
    })(request() as any, res as any, jest.fn());
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not let a failed access transport crash the response callback', () => {
    const logger = loggerSpy();
    logger.log.mockImplementation(() => {
      throw new Error('disk full');
    });
    const res = response();
    createRequestLoggerMiddleware(logger, {
      enabled: true,
      slowRequestMs: 1000,
    })(request() as any, res as any, jest.fn());
    expect(() => res.emit('finish')).not.toThrow();
  });

  it('keeps HTTP failure metadata but never query, exception text, SQL or path secrets', () => {
    const logger = loggerSpy();
    const reply = jest.fn();
    const filter = new AllExceptionFilter(logger, {
      httpAdapter: { reply },
    } as any);
    filter.catch(
      new Error('SELECT private_chat FROM messages WHERE token=secret'),
      host(request()),
    );
    const serialized = JSON.stringify(logger.error.mock.calls);
    for (const privateValue of [
      'private-link',
      'private@example.com',
      'private chat',
      'SELECT',
      'token=secret',
    ])
      expect(serialized).not.toContain(privateValue);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http_error',
        statusCode: 500,
        errorName: 'Error',
      }),
      'HttpError',
    );
    expect(reply).toHaveBeenCalled();
  });

  it('preserves the original response when every log transport throws', () => {
    const logger = loggerSpy();
    for (const log of Object.values(logger))
      log.mockImplementation(() => {
        throw new Error('disk full');
      });
    const reply = jest.fn();
    const filter = new AllExceptionFilter(logger, {
      httpAdapter: { reply },
    } as any);
    expect(() =>
      filter.catch(new ForbiddenException('nope'), host(request())),
    ).not.toThrow();
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      { code: 403, message: 'nope', data: null },
      403,
    );
  });

  it('preserves a server response when an exception has a hostile diagnostic getter', () => {
    const logger = loggerSpy();
    const reply = jest.fn();
    const error = new Error('original');
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('getter failed');
      },
    });
    const filter = new AllExceptionFilter(logger, {
      httpAdapter: { reply },
    } as any);
    expect(() => filter.catch(error, host(request()))).not.toThrow();
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 500 }),
      500,
    );
  });

  it('classifies 4xx as warn and writes the HTTP error only once across interceptor/filter', async () => {
    const logger = loggerSpy();
    const error = new ForbiddenException('private chat');
    const interceptor = new ErrorLoggingInterceptor(logger);
    const filter = new AllExceptionFilter(logger, {
      httpAdapter: { reply: jest.fn() },
    } as any);
    await runWithRequestContext(
      {
        requestId: TEST_REQUEST_ID,
        traceId: TEST_REQUEST_ID,
        method: 'GET',
        path: '/api/v1/note/share-links/:token',
      },
      async () => {
        await expect(
          lastValueFrom(
            interceptor.intercept({} as any, {
              handle: () => throwError(() => error),
            }),
          ),
        ).rejects.toBe(error);
        filter.catch(error, host(request()));
      },
    );
    const httpEvents = logger.warn.mock.calls.filter(
      ([entry]) => entry?.event === 'http_error',
    );
    expect(httpEvents).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'private chat',
    );
  });

  it('deduplicates one error only within the same request context', () => {
    const logger = loggerSpy();
    const error = new Error('private shared failure');
    const write = (requestId: string) =>
      runWithRequestContext(
        {
          requestId,
          traceId: requestId,
          method: 'GET',
          path: '/api/v1/auth/me',
        },
        () => logHttpFailure(logger, error, 500),
      );

    write('9b2a7f3c-2a9e-4f1c-8d2b-124a5cc93a10');
    write('9b2a7f3c-2a9e-4f1c-8d2b-124a5cc93a10');
    write('4c5397be-8ce2-4acd-8a2f-64385b46f40b');

    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('propagates the original exception even if both primary logging and aggregation fail', async () => {
    const logger = loggerSpy();
    for (const log of Object.values(logger))
      log.mockImplementation(() => {
        throw new Error('disk full');
      });
    const aggregation = {
      name: 'sentry' as const,
      captureError: jest.fn(() => {
        throw new Error('offline');
      }),
      flush: jest.fn(),
    };
    const interceptor = new ErrorLoggingInterceptor(logger, aggregation);
    const error = new Error('original');
    await expect(
      lastValueFrom(
        interceptor.intercept({} as any, {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
    expect(aggregation.captureError).toHaveBeenCalled();
  });

  it('does not log Prisma metadata, query text or secret URLs through its specialized filter', () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    try {
      new PrismaExceptionFilter().catch(
        new Prisma.PrismaClientKnownRequestError('private sql', {
          code: 'P1001',
          clientVersion: 'test',
          meta: { query: 'private sql' },
        }),
        host(request(), res),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private-link|private sql|private@example/,
      );
      expect(res.status).toHaveBeenCalledWith(500);
    } finally {
      log.mockRestore();
    }
  });

  it('isolates concurrent request contexts', async () => {
    const run = (id: string) =>
      runWithRequestContext(
        { requestId: id, traceId: id, method: 'GET', path: '/api/v1/auth/me' },
        async () => {
          await Promise.resolve();
          return getRequestContext()?.requestId;
        },
      );
    expect(await Promise.all([run('one'), run('two')])).toEqual(['one', 'two']);
    expect(getRequestContext()).toBeUndefined();
  });
});
