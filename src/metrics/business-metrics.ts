import { Counter, Registry } from 'prom-client';

export type BusinessEventResult = 'success' | 'failure';

export interface BusinessMetrics {
  readonly registry: Registry;
  recordEvent(event: string, result: BusinessEventResult): void;
}

/** Bucket for event names over the budget — bounds `event` label cardinality. */
export const OTHER_EVENT = 'other';

/**
 * Max distinct event names ever emitted. Callers currently pass a fixed set of
 * string literals, so this is generous headroom; it only ever engages if a
 * future caller accidentally passes a high-cardinality (e.g. user-derived)
 * value, which would otherwise blow up Prometheus series count.
 */
const MAX_EVENT_NAMES = 100;

/**
 * App-domain business metrics, kept on a dedicated registry (independent of the
 * HTTP RED registry) and merged into the `/metrics` output. A single
 * low-cardinality counter labeled by event name + result, so Grafana can graph
 * "logins/min", "coin gifts/min", success ratios, etc. without per-event code.
 */
export function createBusinessMetrics(): BusinessMetrics {
  const registry = new Registry();

  const eventsTotal = new Counter({
    name: 'business_events_total',
    help: 'Business domain events, by event name and result.',
    labelNames: ['event', 'result'],
    registers: [registry],
  });

  const seenEvents = new Set<string>();
  const clampEventName = (event: string): string => {
    if (seenEvents.has(event)) {
      return event;
    }
    if (seenEvents.size >= MAX_EVENT_NAMES) {
      return OTHER_EVENT;
    }
    seenEvents.add(event);
    return event;
  };

  return {
    registry,
    recordEvent(event, result) {
      eventsTotal.inc({ event: clampEventName(event), result });
    },
  };
}

/** App-wide singleton used by the business-event logger; exposed via `/metrics`. */
export const businessMetrics = createBusinessMetrics();
