import { WinstonModule } from 'nest-winston';
import fs from 'node:fs';
import * as winston from 'winston';
import { createWinstonOptions } from './winston-options';
import { runWithRequestContext } from './request-context';
import { runWithOperationContext } from './operation-context';

class ConfigServiceLike {
  constructor(private readonly values: Record<string, unknown>) {}

  get(key: string) {
    return this.values[key];
  }
}

describe('createWinstonOptions', () => {
  const openedLoggers: winston.Logger[] = [];
  afterEach(() => {
    openedLoggers.forEach((logger) => logger.close());
    openedLoggers.length = 0;
    jest.restoreAllMocks();
  });

  function capture(
    values: Record<string, unknown>,
    environment = 'production',
  ) {
    const options = createWinstonOptions(
      new ConfigServiceLike({
        LOG_ON: 'true',
        LOG_FILE_ON: 'false',
        ...values,
      }),
      environment,
    );
    const transport = options
      .transports?.[0] as winston.transports.ConsoleTransportInstance;
    const lines: string[] = [];
    // Observe final Console output after the real logger and all formatters.
    jest.spyOn(transport, 'log').mockImplementation((info, callback) => {
      lines.push(info[Symbol.for('message')]);
      callback?.();
    });
    const logger = winston.createLogger(options);
    openedLoggers.push(logger);
    return { logger, options, lines };
  }

  it('emits one-line production JSON with mandatory timestamp and identifiers', () => {
    const { logger, lines } = capture({
      LOG_SERVICE_NAME: 'circle-api',
      SENTRY_RELEASE: 'circle@123',
      TIMESTAMP: 'false',
    });
    logger.info('started\nsecond line', { event: 'startup' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      event: 'startup',
      serviceName: 'circle-api',
      release: 'circle@123',
      environment: 'production',
      timestamp: expect.any(String),
    });
  });

  it('retains readable development output', () => {
    const { logger, lines } = capture({}, 'development');
    logger.info('server started', { context: 'Bootstrap' });
    expect(lines[0]).toContain('server started');
    expect(() => JSON.parse(lines[0])).toThrow();
  });

  it('sanitizes actual Nest object logs, request context and Winston symbol metadata', () => {
    const { logger, lines } = capture({});
    const adapter = WinstonModule.createLogger({ instance: logger });
    runWithRequestContext(
      {
        requestId: 'req-safe',
        traceId: 'req-safe',
        method: 'POST',
        path: '/api/v1/note/share-links/private-path',
        ip: 'private-ip',
      },
      () => {
        adapter.log(
          {
            event: 'business_event',
            businessEvent: 'note_shared',
            actorId: 'user-1',
            metadata: {
              nested: [{ password: 'private-password', body: 'private-chat' }],
            },
          },
          'BusinessEvent',
        );
        logger.info({
          message: 'normal',
          [Symbol.for('message')]: 'private-rendered',
          [Symbol.for('splat')]: [{ private: 'private-splat' }],
          token: 'private-token',
        });
      },
    );
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      event: 'business_event',
      businessEvent: 'note_shared',
      actorId: 'user-1',
      requestId: 'req-safe',
      path: '/api/v1/note/share-links/:token',
    });
    expect(lines.join('')).not.toContain('private-');
  });

  it('removes raw error messages from both Nest error overloads', () => {
    const { logger, lines } = capture({});
    const adapter = WinstonModule.createLogger({ instance: logger });
    adapter.error(
      new TypeError('SELECT private_content FROM messages'),
      undefined,
      'Database',
    );
    adapter.error(
      'SELECT private_text FROM chats',
      'Error: private_text\n    at query (/app/src/database.ts:7:2)',
      'Database',
    );
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toMatch(/private_|SELECT/);
    expect(JSON.parse(lines[1]).stack).toContain('database.ts:7:2');
  });

  it('applies the same privacy and JSON format to every file transport', () => {
    const options = createWinstonOptions(
      new ConfigServiceLike({ LOG_ON: 'true' }),
      'production',
    );
    openedLoggers.push(winston.createLogger(options));
    expect(options.transports).toHaveLength(3);
    const outputs: string[] = [];
    for (const transport of options.transports as winston.transport[]) {
      jest.spyOn(transport, 'log').mockImplementation((info, callback) => {
        outputs.push(info[Symbol.for('message')]);
        callback?.();
      });
    }
    openedLoggers[openedLoggers.length - 1].warn(
      'failed password=private-password',
      { metadata: { email: 'private-email@example.com' } },
    );
    expect(outputs).toHaveLength(3);
    for (const line of outputs) {
      expect(JSON.parse(line).level).toBe('warn');
      expect(line).not.toContain('private-');
      expect(line).not.toContain('\n');
    }
  });

  it('lets stdout deployments disable files while other logging stays enabled', () => {
    const { options } = capture({ LOG_ON: 'true', LOG_FILE_ON: 'false' });
    expect(options.transports).toHaveLength(1);
  });

  it('keeps the LOG_ON master gate when file logging is explicitly enabled', () => {
    const { logger, options, lines } = capture({
      LOG_ON: 'false',
      LOG_FILE_ON: true,
    });
    expect(options.transports).toHaveLength(1);
    logger.error('must stay silent');
    expect(lines).toHaveLength(0);
  });

  it('rejects unsafe deployment identifiers and invalid levels', () => {
    const { logger, lines } = capture({
      LOG_SERVICE_NAME: 'https://private.example/secret',
      SENTRY_RELEASE: 'private@example.com\nforged',
      LOG_LEVEL: 'invalid',
    });
    logger.info('startup');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      serviceName: 'circle-be',
      release: 'unknown',
    });
    expect(lines[0]).not.toContain('private');
  });

  it('attaches job/run identifiers without changing operation return values', () => {
    const { logger, lines } = capture({});
    const result = runWithOperationContext(
      { job: 'outbox_dispatch', runId: 'run-1' },
      () => {
        logger.info('job completed');
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(JSON.parse(lines[0])).toMatchObject({
      job: 'outbox_dispatch',
      runId: 'run-1',
    });
  });

  it('sanitizes nested getters before JSON serialization and leaves input untouched', () => {
    const { logger, lines } = capture({});
    const getter = jest.fn(() => {
      throw new Error('must not run');
    });
    const metadata = { token: 'private-token' };
    Object.defineProperty(metadata, 'computed', {
      enumerable: true,
      get: getter,
    });
    logger.info('operation', { metadata });
    expect(getter).not.toHaveBeenCalled();
    expect(metadata.token).toBe('private-token');
    expect(lines[0]).not.toContain('private-token');
  });

  it('accepts normal semver release identifiers without accepting email addresses', () => {
    const { logger, lines } = capture({ SENTRY_RELEASE: 'circle-be@1.0.0' });
    logger.info('started');
    expect(JSON.parse(lines[0]).release).toBe('circle-be@1.0.0');
  });

  it('survives asynchronous transport errors with one bounded, redacted fallback', () => {
    const fallback: string[] = [];
    jest.spyOn(fs, 'writeSync').mockImplementation((_fd, value) => {
      fallback.push(String(value));
      return String(value).length;
    });
    const { logger, options } = capture({
      LOG_ON: 'true',
      LOG_FILE_ON: 'true',
    });
    for (const transport of options.transports as winston.transport[]) {
      expect(() =>
        transport.emit('error', new Error('ENOSPC private-volume-path')),
      ).not.toThrow();
    }
    expect(() =>
      logger.emit('error', new Error('private-logger-error')),
    ).not.toThrow();
    expect(fallback).toHaveLength(1);
    expect(JSON.parse(fallback[0])).toMatchObject({
      event: 'logging_transport_error',
      level: 'error',
      serviceName: 'circle-be',
    });
    expect(fallback[0]).not.toContain('private');
  });
});
