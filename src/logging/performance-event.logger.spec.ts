import { logExternalCallSlow } from './performance-event.logger';
import { runWithRequestContext } from './request-context';

describe('logExternalCallSlow', () => {
  it('logs slow external calls over threshold', () => {
    const logger = { warn: jest.fn() };

    runWithRequestContext(
      {
        requestId: 'req-1',
        traceId: 'req-1',
        method: 'POST',
        path: '/api/v1/auth/login',
        ip: '127.0.0.1',
        userAgent: 'jest',
      },
      () =>
        logExternalCallSlow(logger as any, {
          enabled: true,
          service: 'openim',
          operation: '/auth/get_user_token',
          durationMs: 1400,
          thresholdMs: 1000,
          result: 'success',
        }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'external_call_slow',
        service: 'openim',
        operation: '/auth/get_user_token',
        durationMs: 1400,
        thresholdMs: 1000,
        result: 'success',
        requestId: 'req-1',
      }),
      'Performance',
    );
  });

  it('skips logging when below threshold', () => {
    const logger = { warn: jest.fn() };

    logExternalCallSlow(logger as any, {
      enabled: true,
      service: 'minio',
      operation: 'presign_put_object',
      durationMs: 300,
      thresholdMs: 1000,
      result: 'success',
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
