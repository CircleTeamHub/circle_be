import { logExternalCallFailure } from './external-service.logger';

describe('logExternalCallFailure', () => {
  it('logs external failures without sensitive details', () => {
    const logger = { warn: jest.fn() };

    logExternalCallFailure(logger as any, {
      enabled: true,
      service: 'openim',
      operation: 'registerUser',
      durationMs: 123,
      error: new Error('failed with token=secret'),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'external_call_failed',
        service: 'openim',
        operation: 'registerUser',
        durationMs: 123,
        errorName: 'Error',
      }),
      'ExternalService',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('token=secret');
  });
});
