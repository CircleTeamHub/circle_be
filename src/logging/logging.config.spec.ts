import { createLoggingConfig } from './logging.config';

describe('createLoggingConfig', () => {
  it('enables development request logging with pretty output by default', () => {
    const config = createLoggingConfig({ LOG_ON: 'true' }, 'development');

    expect(config.logOn).toBe(true);
    expect(config.httpLogOn).toBe(true);
    expect(config.businessLogOn).toBe(true);
    expect(config.externalLogOn).toBe(true);
    expect(config.rateLimitLogOn).toBe(true);
    expect(config.securityLogOn).toBe(true);
    expect(config.performanceLogOn).toBe(true);
    expect(config.slowRequestMs).toBe(1000);
    expect(config.slowExternalMs).toBe(1000);
  });

  it('keeps test logging quiet by default', () => {
    const config = createLoggingConfig({}, 'test');

    expect(config.logOn).toBe(false);
    expect(config.httpLogOn).toBe(false);
    expect(config.businessLogOn).toBe(false);
    expect(config.externalLogOn).toBe(false);
    expect(config.rateLimitLogOn).toBe(false);
    expect(config.securityLogOn).toBe(false);
    expect(config.performanceLogOn).toBe(false);
  });

  it('honors explicit disablement and numeric thresholds', () => {
    const config = createLoggingConfig(
      {
        LOG_ON: 'true',
        HTTP_LOG_ON: 'false',
        BUSINESS_LOG_ON: 'false',
        EXTERNAL_LOG_ON: 'false',
        RATE_LIMIT_LOG_ON: 'false',
        SECURITY_LOG_ON: 'false',
        PERFORMANCE_LOG_ON: 'false',
        SLOW_REQUEST_MS: '250',
        SLOW_EXTERNAL_MS: '400',
      },
      'development',
    );

    expect(config.httpLogOn).toBe(false);
    expect(config.businessLogOn).toBe(false);
    expect(config.externalLogOn).toBe(false);
    expect(config.rateLimitLogOn).toBe(false);
    expect(config.securityLogOn).toBe(false);
    expect(config.performanceLogOn).toBe(false);
    expect(config.slowRequestMs).toBe(250);
    expect(config.slowExternalMs).toBe(400);
  });
});
