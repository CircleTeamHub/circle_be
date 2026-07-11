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
});
