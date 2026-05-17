import * as winston from 'winston';
import { createWinstonOptions } from './winston-options';

class ConfigServiceLike {
  constructor(private readonly values: Record<string, unknown>) {}

  get(key: string) {
    return this.values[key];
  }
}

describe('createWinstonOptions', () => {
  it('uses readable console logging outside production', () => {
    const options = createWinstonOptions(
      new ConfigServiceLike({ LOG_ON: 'false', LOG_LEVEL: 'debug' }),
      'development',
    );

    expect(options.transports).toHaveLength(1);
    expect(options.transports?.[0]).toBeInstanceOf(winston.transports.Console);
  });

  it('adds rotated file transports when file logging is enabled', () => {
    const options = createWinstonOptions(
      new ConfigServiceLike({ LOG_ON: 'true' }),
      'development',
    );

    expect(options.transports).toHaveLength(3);
  });

  it('keeps production formatting out of the development logging phase', () => {
    const options = createWinstonOptions(
      new ConfigServiceLike({ LOG_ON: 'false' }),
      'production',
    );
    const consoleTransport = options.transports?.[0] as winston.transports.ConsoleTransportInstance;
    const transformed = consoleTransport.format?.transform({
      level: 'info',
      message: 'hello',
      context: 'TestContext',
    });

    expect(transformed).toMatchObject({
      level: 'info',
      message: 'hello',
      context: 'TestContext',
    });
  });
});
