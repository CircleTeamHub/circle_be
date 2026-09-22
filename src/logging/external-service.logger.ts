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
