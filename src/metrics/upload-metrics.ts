import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type UploadPresignLimitStore = 'redis' | 'memory' | 'bulkhead';
export type UploadIntentFolder = 'avatars' | 'posts';
export type UploadIntentEvent =
  | 'created'
  | 'claimed'
  | 'rescued'
  | 'due'
  | 'deleted'
  | 'delete_failed'
  | 'would_rescue'
  | 'would_delete';
export type UploadIntentMode = 'request' | 'report' | 'delete';

export interface UploadMetrics {
  readonly registry: Registry;
  recordPresignLimited(store: UploadPresignLimitStore): void;
  observePresign(
    result: 'success' | 'failure',
    durationSeconds: number,
    sizeBytes: number,
  ): void;
  recordIntentEvent(
    folder: UploadIntentFolder,
    event: UploadIntentEvent,
    mode: UploadIntentMode,
    count?: number,
  ): void;
  setIntentPending(
    folder: UploadIntentFolder,
    mode: Exclude<UploadIntentMode, 'request'>,
    count: number,
    bytes: number,
  ): void;
  setIntentBacklog(
    mode: Exclude<UploadIntentMode, 'request'>,
    count: number,
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
  const intentEvents = new Counter({
    name: 'upload_intent_events_total',
    help: 'Upload intent lifecycle events by bounded folder, event and mode.',
    labelNames: ['folder', 'event', 'mode'],
    registers: [registry],
  });
  const intentPendingCount = new Gauge({
    name: 'upload_intent_pending_count',
    help: 'Current pending upload intent count by bounded folder and GC mode.',
    labelNames: ['folder', 'mode'],
    registers: [registry],
  });
  const intentPendingBytes = new Gauge({
    name: 'upload_intent_pending_bytes',
    help: 'Current pending upload intent bytes by bounded folder and GC mode.',
    labelNames: ['folder', 'mode'],
    registers: [registry],
  });
  const intentReclaimBacklog = new Gauge({
    name: 'upload_intent_reclaim_backlog_count',
    help: 'Due upload intents remaining after the bounded reclamation run.',
    labelNames: ['mode'],
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
    recordIntentEvent(folder, event, mode, count = 1) {
      intentEvents.inc({ folder, event, mode }, count);
    },
    setIntentPending(folder, mode, count, bytes) {
      intentPendingCount.set({ folder, mode }, count);
      intentPendingBytes.set({ folder, mode }, bytes);
    },
    setIntentBacklog(mode, count) {
      intentReclaimBacklog.set({ mode }, count);
    },
  };
}

export const uploadMetrics = createUploadMetrics();
