import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/** A single completed HTTP request to record. `route` must already be normalized. */
export interface HttpRequestSample {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}

export interface Metrics {
  readonly registry: Registry;
  recordHttpRequest(sample: HttpRequestSample): void;
}

export interface CreateMetricsOptions {
  /** Collect default Node/process metrics (cpu, memory, event loop). Default true. */
  collectDefault?: boolean;
}

// Latency buckets in seconds — tuned for an API (5ms .. 10s) so p50/p95/p99 are
// meaningful without excessive bucket cardinality.
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * Builds an isolated metrics registry with HTTP RED metrics
 * (Rate/Errors/Duration) plus default process metrics. A fresh registry per
 * call keeps tests free of global-registry collisions.
 */
export function createMetrics(options: CreateMetricsOptions = {}): Metrics {
  const registry = new Registry();

  if (options.collectDefault !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const requestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests, by method, route and status code.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const requestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method, route and status code.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  return {
    registry,
    recordHttpRequest({ method, route, statusCode, durationSeconds }) {
      const labels = {
        method: method.toUpperCase(),
        route,
        status_code: String(statusCode),
      };
      requestsTotal.inc(labels);
      requestDuration.observe(labels, durationSeconds);
    },
  };
}
