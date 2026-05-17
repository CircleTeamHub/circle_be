import { LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';

export interface ExternalCallFailurePayload {
  enabled: boolean;
  service: string;
  operation: string;
  durationMs?: number;
  error: unknown;
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function getSafeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'External service call failed';
  }

  return error.message.replace(
    /(token|secret|password|authorization)=\S+/gi,
    '$1=[redacted]',
  );
}

export function logExternalCallFailure(
  logger: LoggerService,
  payload: ExternalCallFailurePayload,
): void {
  if (!payload.enabled) {
    return;
  }

  const requestContext = getRequestContext();
  logger.warn(
    {
      event: 'external_call_failed',
      service: payload.service,
      operation: payload.operation,
      durationMs: payload.durationMs,
      requestId: requestContext?.requestId,
      traceId: requestContext?.traceId,
      errorName: getErrorName(payload.error),
      message: getSafeErrorMessage(payload.error),
    },
    'ExternalService',
  );
}
