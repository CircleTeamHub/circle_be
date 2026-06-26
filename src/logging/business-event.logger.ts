import { LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';
import { businessMetrics } from '../metrics/business-metrics';

type BusinessEventResult = 'success' | 'failure';

export interface BusinessEventPayload {
  enabled: boolean;
  businessEvent: string;
  result: BusinessEventResult;
  actorId?: string;
  targetId?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'secret',
  'code',
]);

function sanitizeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !SENSITIVE_KEYS.has(key.toLowerCase()),
    ),
  );
}

export function logBusinessEvent(
  logger: LoggerService,
  payload: BusinessEventPayload,
): void {
  // Count every business event regardless of log verbosity — metrics are an
  // independent always-on concern (like the HTTP RED metrics).
  businessMetrics.recordEvent(payload.businessEvent, payload.result);

  if (!payload.enabled) {
    return;
  }

  const requestContext = getRequestContext();
  logger.log(
    {
      event: 'business_event',
      businessEvent: payload.businessEvent,
      result: payload.result,
      actorId: payload.actorId,
      targetId: payload.targetId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      requestId: requestContext?.requestId,
      traceId: requestContext?.traceId,
      metadata: sanitizeMetadata(payload.metadata),
    },
    'BusinessEvent',
  );
}
