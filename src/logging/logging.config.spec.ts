import { createLoggingConfig } from './logging.config';

describe('createLoggingConfig', () => {
  it('enables development request logging with pretty output by default', () => {
    const config = createLoggingConfig({ LOG_ON: 'true' }, 'development');

    expect(config.logOn).toBe(true);
    expect(config.httpLogOn).toBe(true);
    expect(config.businessLogOn).toBe(true);
    expect(config.externalLogOn).toBe(true);
    expect(config.rateLimitLogOn).toBe(true);
    expect(config.slowRequestMs).toBe(1000);
  });

  it('keeps test logging quiet by default', () => {
    const config = createLoggingConfig({}, 'test');

    expect(config.logOn).toBe(false);
    expect(config.httpLogOn).toBe(false);
    expect(config.businessLogOn).toBe(false);
    expect(config.externalLogOn).toBe(false);
    expect(config.rateLimitLogOn).toBe(false);
  });

  it('honors explicit disablement and numeric thresholds', () => {
    const config = createLoggingConfig(
      {
        LOG_ON: 'true',
        HTTP_LOG_ON: 'false',
        BUSINESS_LOG_ON: 'false',
        EXTERNAL_LOG_ON: 'false',
        RATE_LIMIT_LOG_ON: 'false',
        SLOW_REQUEST_MS: '250',
      },
      'development',
    );

    expect(config.httpLogOn).toBe(false);
    expect(config.businessLogOn).toBe(false);
    expect(config.externalLogOn).toBe(false);
    expect(config.rateLimitLogOn).toBe(false);
    expect(config.slowRequestMs).toBe(250);
  });
});
