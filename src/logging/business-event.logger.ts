import { LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';
import { businessMetrics } from '../metrics/business-metrics';
import { sanitizeLogValue } from './log-sanitizer';

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

export function logBusinessEvent(
  logger: LoggerService,
  payload: BusinessEventPayload,
): void {
  // Count every business event regardless of log verbosity — metrics are an
  // independent always-on concern (like the HTTP RED metrics).
  try {
    businessMetrics.recordEvent(payload.businessEvent, payload.result);
  } catch {
    // A failed metric must not replace the business result or skip its log.
  }

  if (!payload.enabled) {
    return;
  }

  try {
    const requestContext = getRequestContext();
    logger.log(
      sanitizeLogValue({
        event: 'business_event',
        businessEvent: payload.businessEvent,
        result: payload.result,
        actorId: payload.actorId,
        targetId: payload.targetId,
        entityType: payload.entityType,
        entityId: payload.entityId,
        requestId: requestContext?.requestId,
        traceId: requestContext?.traceId,
        metadata: payload.metadata,
      }),
      'BusinessEvent',
    );
  } catch {
    // The business operation may already be committed. Diagnostics are best effort.
  }
}
