import { LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';
import { sanitizeLogValue } from './log-sanitizer';

export interface SecurityEventPayload {
  enabled: boolean;
  securityEvent: string;
  statusCode?: number;
  reason?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export function logSecurityEvent(
  logger: LoggerService,
  payload: SecurityEventPayload,
): void {
  if (!payload.enabled) {
    return;
  }

  const requestContext = getRequestContext();
  logger.warn(
    sanitizeLogValue({
      event: 'security_event',
      securityEvent: payload.securityEvent,
      statusCode: payload.statusCode,
      reason: payload.reason,
      requestId: requestContext?.requestId,
      traceId: requestContext?.traceId,
      method: requestContext?.method,
      path: requestContext?.path,
      userId: payload.userId ?? requestContext?.userId,
      metadata: payload.metadata,
    }),
    'SecurityEvent',
  );
}
