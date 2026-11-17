import { createUploadMetrics } from './upload-metrics';

describe('createUploadMetrics', () => {
  it('records upload presign rejections by bounded store type', async () => {
    const metrics = createUploadMetrics();

    metrics.recordPresignLimited('redis');
    metrics.recordPresignLimited('memory');
    metrics.observePresign('success', 0.01, 1024);
    metrics.observePresign('failure', 0.02, 2048);

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /upload_presign_rate_limited_total\{store="redis"\}\s+1/,
    );
    expect(output).toMatch(
      /upload_presign_rate_limited_total\{store="memory"\}\s+1/,
    );
    expect(output).toMatch(
      /upload_presign_requests_total\{result="success"\}\s+1/,
    );
    expect(output).toMatch(/upload_presign_issued_bytes_total\s+1024/);
  });

  it('records bounded upload-intent lifecycle events and pending gauges', async () => {
    const metrics = createUploadMetrics();

    metrics.recordIntentEvent('posts', 'created', 'request');
    metrics.recordIntentEvent('posts', 'claimed', 'request');
    metrics.recordIntentEvent('avatars', 'rescued', 'delete');
    metrics.recordIntentEvent('posts', 'due', 'report', 2);
    metrics.recordIntentEvent('posts', 'deleted', 'delete');
    metrics.recordIntentEvent('posts', 'delete_failed', 'delete');
    metrics.recordIntentEvent('posts', 'would_rescue', 'report');
    metrics.recordIntentEvent('posts', 'would_delete', 'report');
    metrics.setIntentPending('posts', 'delete', 3, 4096);
    metrics.setIntentBacklog('report', 17);

    const output = await metrics.registry.metrics();
    for (const event of [
      'created',
      'claimed',
      'rescued',
      'due',
      'deleted',
      'delete_failed',
      'would_rescue',
      'would_delete',
    ]) {
      expect(output).toContain(`event="${event}"`);
    }
    expect(output).toMatch(
      /upload_intent_pending_count\{folder="posts",mode="delete"\}\s+3/,
    );
    expect(output).toMatch(
      /upload_intent_pending_bytes\{folder="posts",mode="delete"\}\s+4096/,
    );
    expect(output).toMatch(
      /upload_intent_reclaim_backlog_count\{mode="report"\}\s+17/,
    );
    expect(output).not.toMatch(/objectKey|object_key|userID|user_id/);
  });
});
