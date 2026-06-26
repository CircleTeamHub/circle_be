import { Counter, Registry } from 'prom-client';

export type BusinessEventResult = 'success' | 'failure';

export interface BusinessMetrics {
  readonly registry: Registry;
  recordEvent(event: string, result: BusinessEventResult): void;
}

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

  return {
    registry,
    recordEvent(event, result) {
      eventsTotal.inc({ event, result });
    },
  };
}

/** App-wide singleton used by the business-event logger; exposed via `/metrics`. */
export const businessMetrics = createBusinessMetrics();
