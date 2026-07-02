import { logBusinessEvent } from './business-event.logger';

describe('logBusinessEvent', () => {
  it('logs sanitized business events when enabled', () => {
    const logger = { log: jest.fn() };

    logBusinessEvent(logger as any, {
      enabled: true,
      businessEvent: 'auth_login_success',
      actorId: 'user-1',
      result: 'success',
      metadata: {
        password: 'secret',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        safe: 'value',
      },
    });

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'business_event',
        businessEvent: 'auth_login_success',
        actorId: 'user-1',
        result: 'success',
        metadata: { safe: 'value' },
      }),
      'BusinessEvent',
    );
  });

  it('redacts sensitive keys regardless of casing', () => {
    const logger = { log: jest.fn() };

    logBusinessEvent(logger as any, {
      enabled: true,
      businessEvent: 'auth_login_success',
      result: 'success',
      metadata: {
        AccessToken: 'access-token',
        PasswordHash: 'hash',
        Authorization: 'Bearer x',
        safe: 'value',
      },
    });

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { safe: 'value' } }),
      'BusinessEvent',
    );
  });

  it('does nothing when disabled', () => {
    const logger = { log: jest.fn() };

    logBusinessEvent(logger as any, {
      enabled: false,
      businessEvent: 'auth_login_success',
      result: 'success',
    });

    expect(logger.log).not.toHaveBeenCalled();
  });
});
