import { utilities } from 'nest-winston';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { WinstonModuleOptions } from 'nest-winston';
import { LogEnum } from 'src/enum/config.enum';
import { createLoggingConfig } from './logging.config';
import { getRequestContext } from './request-context';

interface ConfigServiceLike {
  get(key: string): unknown;
}

function createContextFormat() {
  return winston.format((info) => {
    const context = getRequestContext();
    if (!context) {
      return info;
    }

    return Object.assign(info, {
      requestId: context.requestId,
      traceId: context.traceId,
      userId: context.userId,
      method: context.method,
      path: context.path,
    });
  })();
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
    zippedArchive: true,
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
  const timestampEnabled = configService.get(LogEnum.TIMESTAMP) === 'true';
  const baseFormats = [createContextFormat()];

  if (timestampEnabled) {
    baseFormats.push(winston.format.timestamp());
  }

  const outputFormat = utilities.format.nestLike();

  const consoleFormat = winston.format.combine(...baseFormats, outputFormat);
  const fileFormat = winston.format.combine(
    createContextFormat(),
    winston.format.timestamp(),
    winston.format.simple(),
  );

  return {
    transports: [
      new winston.transports.Console({
        level: String(configService.get(LogEnum.LOG_LEVEL) || 'info'),
        format: consoleFormat,
      }),
      ...(loggingConfig.logOn
        ? [
            createDailyRotateTransport('info', 'application', 14, fileFormat),
            createDailyRotateTransport('warn', 'error', 14, fileFormat),
          ]
        : []),
    ],
  };
}
