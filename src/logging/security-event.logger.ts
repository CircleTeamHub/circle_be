import { LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';

const SENSITIVE_KEY_PATTERN = /(password|token|secret|authorization|cookie)/i;

export interface SecurityEventPayload {
  enabled: boolean;
  securityEvent: string;
  statusCode?: number;
  reason?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

function sanitizeText(value: string): string {
  return value
    .replace(/(authorization=)[^\s]+(?:\s+[^\s]+)*/gi, '$1[redacted]')
    .replace(/(cookie=)[^\s]+(?:;\s*[^\s;=]+=[^\s;]+)*/gi, '$1[redacted]')
    .replace(/(password|token|secret)=\S+/gi, '$1=[redacted]');
}

function sanitizeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitizedEntries = Object.entries(metadata).map(([key, value]) => {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      return [key, '[redacted]'];
    }

    if (typeof value === 'string') {
      return [key, sanitizeText(value)];
    }

    return [key, value];
  });

  return Object.fromEntries(sanitizedEntries);
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
    {
      event: 'security_event',
      securityEvent: payload.securityEvent,
      statusCode: payload.statusCode,
      reason:
        typeof payload.reason === 'string'
          ? sanitizeText(payload.reason)
          : payload.reason,
      requestId: requestContext?.requestId,
      traceId: requestContext?.traceId,
      method: requestContext?.method,
      path: requestContext?.path,
      userId: payload.userId ?? requestContext?.userId,
      ip: requestContext?.ip,
      metadata: sanitizeMetadata(payload.metadata),
    },
    'SecurityEvent',
  );
}
