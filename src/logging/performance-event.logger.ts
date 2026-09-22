import { LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';

export interface ExternalCallSlowPayload {
  enabled: boolean;
  service: string;
  operation: string;
  durationMs: number;
  thresholdMs: number;
  result: 'success' | 'failure';
}

export function logExternalCallSlow(
  logger: LoggerService,
  payload: ExternalCallSlowPayload,
): void {
  if (!payload.enabled || payload.durationMs < payload.thresholdMs) {
    return;
  }

  try {
    const requestContext = getRequestContext();
    logger.warn(
      {
        event: 'external_call_slow',
        service: payload.service,
        operation: payload.operation,
        durationMs: payload.durationMs,
        thresholdMs: payload.thresholdMs,
        result: payload.result,
        requestId: requestContext?.requestId,
        traceId: requestContext?.traceId,
      },
      'Performance',
    );
  } catch {
    // This often runs in finally; logging must not change the SDK outcome.
  }
}
