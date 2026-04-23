export interface LoggingConfig {
  logOn: boolean;
  httpLogOn: boolean;
  slowRequestMs: number;
  businessLogOn: boolean;
  externalLogOn: boolean;
  rateLimitLogOn: boolean;
  securityLogOn: boolean;
  performanceLogOn: boolean;
  slowExternalMs: number;
}

function readBoolean(
  value: unknown,
  defaultValue: boolean,
): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return defaultValue;
}

function readPositiveInteger(
  value: unknown,
  defaultValue: number,
): number {
  const numberValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;

  return Number.isInteger(numberValue) && numberValue > 0
    ? numberValue
    : defaultValue;
}

export function createLoggingConfig(
  rawConfig: Record<string, unknown> = process.env,
  nodeEnv = process.env.NODE_ENV || 'development',
): LoggingConfig {
  const isTest = nodeEnv === 'test';
  const logOn = readBoolean(rawConfig['LOG_ON'], !isTest);

  return {
    logOn,
    httpLogOn:
      logOn && readBoolean(rawConfig['HTTP_LOG_ON'], !isTest),
    slowRequestMs: readPositiveInteger(rawConfig['SLOW_REQUEST_MS'], 1000),
    businessLogOn:
      logOn && readBoolean(rawConfig['BUSINESS_LOG_ON'], !isTest),
    externalLogOn:
      logOn && readBoolean(rawConfig['EXTERNAL_LOG_ON'], !isTest),
    rateLimitLogOn:
      logOn && readBoolean(rawConfig['RATE_LIMIT_LOG_ON'], !isTest),
    securityLogOn:
      logOn && readBoolean(rawConfig['SECURITY_LOG_ON'], !isTest),
    performanceLogOn:
      logOn && readBoolean(rawConfig['PERFORMANCE_LOG_ON'], !isTest),
    slowExternalMs: readPositiveInteger(rawConfig['SLOW_EXTERNAL_MS'], 1000),
  };
}
