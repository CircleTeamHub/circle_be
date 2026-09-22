import { logBusinessEvent } from './business-event.logger';
import { businessMetrics } from '../metrics/business-metrics';

describe('logBusinessEvent', () => {
  afterEach(() => jest.restoreAllMocks());

  it('still attempts the event log when metrics fail after a business commit', () => {
    const logger = { log: jest.fn() };
    jest.spyOn(businessMetrics, 'recordEvent').mockImplementationOnce(() => {
      throw new Error('metrics unavailable');
    });
    expect(() =>
      logBusinessEvent(logger as any, {
        enabled: true,
        businessEvent: 'transaction_committed',
        result: 'success',
      }),
    ).not.toThrow();
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        businessEvent: 'transaction_committed',
        result: 'success',
      }),
      'BusinessEvent',
    );
  });

  it('records metrics and preserves the business result when its logger throws', () => {
    const logger = {
      log: jest.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const record = jest.spyOn(businessMetrics, 'recordEvent');
    const result = { id: 'committed-transaction' };
    const completedBusinessAction = () => {
      logBusinessEvent(logger as any, {
        enabled: true,
        businessEvent: 'transaction_committed',
        result: 'success',
      });
      return result;
    };
    expect(completedBusinessAction()).toBe(result);
    expect(record).toHaveBeenCalledWith('transaction_committed', 'success');
  });

  it('attempts metrics independently with event logs disabled and tolerates failure', () => {
    const logger = { log: jest.fn() };
    const record = jest
      .spyOn(businessMetrics, 'recordEvent')
      .mockImplementationOnce(() => {
        throw new Error('metrics unavailable');
      });
    expect(() =>
      logBusinessEvent(logger as any, {
        enabled: false,
        businessEvent: 'transaction_committed',
        result: 'success',
      }),
    ).not.toThrow();
    expect(record).toHaveBeenCalledWith('transaction_committed', 'success');
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('redacts nested request/chat data while preserving operational metadata', () => {
    const logger = { log: jest.fn() };
    logBusinessEvent(logger as any, {
      enabled: true,
      businessEvent: 'note_shared',
      result: 'success',
      actorId: 'user-1',
      entityId: 'note-1',
      metadata: {
        nested: [{ token: 'private-token', body: 'private-chat' }],
        durationMs: 12,
      },
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private-');
    expect(logger.log.mock.calls[0][0]).toMatchObject({
      actorId: 'user-1',
      entityId: 'note-1',
      metadata: { durationMs: 12 },
    });
  });
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
        metadata: {
          password: '[redacted]',
          accessToken: '[redacted]',
          refreshToken: '[redacted]',
          safe: 'value',
        },
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
      expect.objectContaining({
        metadata: {
          AccessToken: '[redacted]',
          PasswordHash: '[redacted]',
          Authorization: '[redacted]',
          safe: 'value',
        },
      }),
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
