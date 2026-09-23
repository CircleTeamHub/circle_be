import { utilities } from 'nest-winston';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { WinstonModuleOptions } from 'nest-winston';
import { LogEnum } from 'src/enum/config.enum';
import { createLoggingConfig } from './logging.config';
import { getRequestContext } from './request-context';
import { getOperationContext } from './operation-context';
import { sanitizeLogValue } from './log-sanitizer';
import { writeSync } from 'node:fs';

interface ConfigServiceLike {
  get(key: string): unknown;
}

function createSafeFormat(identifiers: Record<string, string>) {
  return winston.format((info) => {
    const sanitized = sanitizeLogValue(info);
    const result =
      sanitized && typeof sanitized === 'object'
        ? (sanitized as winston.Logform.TransformableInfo)
        : { level: 'error', message: '[unserializable]' };
    const request = getRequestContext();
    const context = sanitizeLogValue({
      ...(request
        ? {
            requestId: request.requestId,
            traceId: request.traceId,
            userId: request.userId,
            method: request.method,
            path: request.path,
          }
        : {}),
      ...getOperationContext(),
    });
    Object.assign(result, context, identifiers);
    // Only the level routing symbol survives. Preformatted MESSAGE/SPLAT may
    // contain raw values and must never bypass the serialization boundary.
    const level = Object.getOwnPropertyDescriptor(info, 'level')?.value;
    result.level = validLevel(level);
    result[Symbol.for('level')] = result.level;
    return result;
  })();
}

function validLevel(value: unknown): string {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(winston.config.npm.levels, value)
    ? value
    : 'info';
}

function identifier(value: unknown, fallback: string): string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,99}$/.test(value) &&
    !/^[^@]+@[^@]+\.[A-Za-z]{2,}$/.test(value)
    ? value
    : fallback;
}

function createDailyRotateTransport(
  level: string,
  filename: string,
  retentionDays: number,
  format: winston.Logform.Format,
) {
  return new DailyRotateFile({
    level,
    dirname: 'logs',
    filename: `${filename}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD-HH',
    // Keep rotated segments readable by collectors catching up after downtime.
    zippedArchive: false,
    options: { flags: 'a', mode: 0o644 },
    maxSize: '20m',
    maxFiles: `${retentionDays}d`,
    format,
  });
}

function getRawConfig(
  configService: ConfigServiceLike,
): Record<string, unknown> {
  return {
    LOG_ON: configService.get(LogEnum.LOG_ON),
    LOG_LEVEL: configService.get(LogEnum.LOG_LEVEL),
  };
}

export function createWinstonOptions(
  configService: ConfigServiceLike,
  nodeEnv = process.env.NODE_ENV || 'development',
): WinstonModuleOptions {
  const rawConfig = getRawConfig(configService);
  const loggingConfig = createLoggingConfig(rawConfig, nodeEnv);
  const rawTimestamp = configService.get(LogEnum.TIMESTAMP);
  const timestampEnabled =
    rawTimestamp === true ||
    (typeof rawTimestamp === 'string' &&
      rawTimestamp.trim().toLowerCase() === 'true');
  const production = nodeEnv === 'production';
  const identifiers = {
    serviceName: identifier(configService.get('LOG_SERVICE_NAME'), 'circle-be'),
    release: identifier(configService.get('SENTRY_RELEASE'), 'unknown'),
    environment: identifier(nodeEnv, 'unknown'),
  };
  const rawFileOn = configService.get('LOG_FILE_ON');
  const normalizedFileOn =
    typeof rawFileOn === 'string' ? rawFileOn.trim().toLowerCase() : rawFileOn;
  // One-release compatibility window: deployments that predate LOG_FILE_ON
  // keep their previous LOG_ON-controlled file behavior. New deployments set
  // the flag explicitly, and can independently choose stdout-only logging.
  const fileSetting =
    normalizedFileOn === undefined || normalizedFileOn === null
      ? loggingConfig.logOn
      : normalizedFileOn === true || normalizedFileOn === 'true';
  const fileOn = loggingConfig.logOn && fileSetting;
  const consoleFormat = production
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(
        ...(timestampEnabled ? [winston.format.timestamp()] : []),
        utilities.format.nestLike(),
      );
  const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  );
  const transports: winston.transport[] = [
    new winston.transports.Console({
      level: validLevel(configService.get(LogEnum.LOG_LEVEL)),
      format: consoleFormat,
    }),
    ...(fileOn
      ? [
          createDailyRotateTransport('info', 'application', 14, fileFormat),
          createDailyRotateTransport('warn', 'error', 14, fileFormat),
        ]
      : []),
  ];
  let lastFailureAt = -Infinity;
  const reportTransportError = () => {
    const now = Date.now();
    if (now - lastFailureAt < 60_000) return;
    lastFailureAt = now;
    try {
      // Do not use Winston recursively or serialize the original failure,
      // which may contain disk paths, credentials, or the log being written.
      writeSync(
        2,
        `${JSON.stringify({ level: 'error', event: 'logging_transport_error', timestamp: new Date(now).toISOString(), ...identifiers })}\n`,
      );
    } catch {
      /* A broken stderr must not replace the business outcome. */
    }
  };
  const guardedLoggers = new WeakSet<winston.Logger>();
  for (const transport of transports) {
    transport.on('error', reportTransportError);
    // Winston forwards transport errors to the parent Logger, which also
    // needs an error listener. 'pipe' runs when Nest creates that Logger.
    transport.on('pipe', (logger: winston.Logger) => {
      if (!guardedLoggers.has(logger)) {
        guardedLoggers.add(logger);
        logger.on('error', reportTransportError);
      }
    });
  }

  return {
    // This runs before ANY transport or serializer, including development.
    silent: !loggingConfig.logOn,
    format: createSafeFormat(identifiers),
    transports,
  };
}
