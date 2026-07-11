import { Counter, Histogram, Registry } from 'prom-client';

export type UploadPresignLimitStore = 'redis' | 'memory' | 'bulkhead';

export interface UploadMetrics {
  readonly registry: Registry;
  recordPresignLimited(store: UploadPresignLimitStore): void;
  observePresign(
    result: 'success' | 'failure',
    durationSeconds: number,
    sizeBytes: number,
  ): void;
}

export function createUploadMetrics(): UploadMetrics {
  const registry = new Registry();
  const presignLimited = new Counter({
    name: 'upload_presign_rate_limited_total',
    help: 'Upload presign requests rejected by the per-user limiter.',
    labelNames: ['store'],
    registers: [registry],
  });
  const presignRequests = new Counter({
    name: 'upload_presign_requests_total',
    help: 'Upload presign attempts by result.',
    labelNames: ['result'],
    registers: [registry],
  });
  const presignDuration = new Histogram({
    name: 'upload_presign_duration_seconds',
    help: 'Upload presign request duration.',
    labelNames: ['result'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [registry],
  });
  const issuedBytes = new Counter({
    name: 'upload_presign_issued_bytes_total',
    help: 'Bytes authorized by successful upload presigns.',
    registers: [registry],
  });

  return {
    registry,
    recordPresignLimited(store) {
      presignLimited.inc({ store });
    },
    observePresign(result, durationSeconds, sizeBytes) {
      presignRequests.inc({ result });
      presignDuration.observe({ result }, durationSeconds);
      if (result === 'success') issuedBytes.inc(sizeBytes);
    },
  };
}

export const uploadMetrics = createUploadMetrics();
