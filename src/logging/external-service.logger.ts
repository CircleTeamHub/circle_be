import { LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';
import { sanitizeLogValue } from './log-sanitizer';

export interface ExternalCallFailurePayload {
  enabled: boolean;
  service: string;
  operation: string;
  durationMs?: number;
  error: unknown;
}

function dataField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function boundedStatus(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

/** Preserve only stable, non-content-bearing provider failure categories. */
function externalFailureCode(error: unknown): string | undefined {
  const systemCode = dataField(error, 'code');
  if (typeof systemCode === 'string' && /^E[A-Z0-9_]{1,31}$/.test(systemCode)) {
    return systemCode;
  }
  const responseCode = boundedStatus(dataField(error, 'responseCode'));
  if (responseCode) return `SMTP_${responseCode}`;
  const directStatus =
    boundedStatus(dataField(error, 'statusCode')) ??
    boundedStatus(dataField(error, 'status'));
  if (directStatus) return `HTTP_${directStatus}`;
  const metadata = dataField(error, '$metadata');
  const metadataStatus = boundedStatus(dataField(metadata, 'httpStatusCode'));
  return metadataStatus ? `HTTP_${metadataStatus}` : undefined;
}

export function logExternalCallFailure(
  logger: LoggerService,
  payload: ExternalCallFailurePayload,
): void {
  if (!payload.enabled) {
    return;
  }

  try {
    const requestContext = getRequestContext();
    const error = sanitizeLogValue(payload.error) as
      | { name?: string }
      | undefined;
    logger.warn(
      {
        ...(sanitizeLogValue({
          event: 'external_call_failed',
          service: payload.service,
          operation: payload.operation,
          durationMs: payload.durationMs,
          requestId: requestContext?.requestId,
          traceId: requestContext?.traceId,
          errorName: error?.name ?? 'Error',
          failureCode: externalFailureCode(payload.error),
          error: payload.error,
        }) as Record<string, unknown>),
        message: 'External service call failed',
      },
      'ExternalService',
    );
  } catch {
    // Preserve the original provider failure if the logging sink is unavailable.
  }
}
