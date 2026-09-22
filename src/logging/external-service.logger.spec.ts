import { logExternalCallFailure } from './external-service.logger';

describe('logExternalCallFailure', () => {
  it('does not replace the original provider failure when the logger throws', async () => {
    const original = new Error('provider unavailable');
    const logger = {
      warn: jest.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const providerCall = async () => {
      try {
        throw original;
      } catch (error) {
        logExternalCallFailure(logger as any, {
          enabled: true,
          service: 'smtp',
          operation: 'send',
          error,
        });
        throw error;
      }
    };
    await expect(providerCall()).rejects.toBe(original);
  });

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
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'token=secret',
    );
  });

  it('redacts recipient addresses echoed by external services', () => {
    const logger = { warn: jest.fn() };

    logExternalCallFailure(logger as any, {
      enabled: true,
      service: 'smtp',
      operation: 'send_verification_code',
      error: new Error(
        '550 5.1.1 <private.user@example.com>: Recipient address rejected',
      ),
    });

    const loggedPayload = logger.warn.mock.calls[0]?.[0];
    expect(loggedPayload.message).toBe('External service call failed');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'private.user@example.com',
    );
  });

  it('suppresses arbitrary provider payloads and SQL in error messages', () => {
    const logger = { warn: jest.fn() };
    const error = new TypeError('SELECT private_content FROM chats');
    error.stack =
      'TypeError: private_content\n    at fetch (/app/src/provider.ts:5:2)';
    logExternalCallFailure(logger as any, {
      enabled: true,
      service: 'smtp',
      operation: 'send',
      error,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'private_content',
    );
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      errorName: 'TypeError',
      error: { stack: expect.stringContaining('provider.ts:5:2') },
    });
  });
});
