import { createMetrics } from './metrics.service';

describe('createMetrics', () => {
  it('exposes a registry with the Prometheus text content type', () => {
    const metrics = createMetrics({ collectDefault: false });
    expect(metrics.registry.contentType).toContain('text/plain');
  });

  it('records an http request as a counter with method/route/status labels', async () => {
    const metrics = createMetrics({ collectDefault: false });

    metrics.recordHttpRequest({
      method: 'get',
      route: '/api/v1/circle/:id',
      statusCode: 200,
      durationSeconds: 0.012,
    });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(/http_requests_total\{[^}]*\bmethod="GET"[^}]*\}\s+1/);
    expect(text).toContain('route="/api/v1/circle/:id"');
    expect(text).toContain('status_code="200"');
  });

  it('observes request duration in a histogram', async () => {
    const metrics = createMetrics({ collectDefault: false });

    metrics.recordHttpRequest({
      method: 'GET',
      route: '/api/v1/ping',
      statusCode: 200,
      durationSeconds: 0.5,
    });

    const text = await metrics.registry.metrics();
    expect(text).toContain('http_request_duration_seconds_bucket');
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*\}\s+1/);
  });

  it('accumulates repeated requests to the same route', async () => {
    const metrics = createMetrics({ collectDefault: false });
    const sample = {
      method: 'POST',
      route: '/api/v1/trace',
      statusCode: 201,
      durationSeconds: 0.02,
    };

    metrics.recordHttpRequest(sample);
    metrics.recordHttpRequest(sample);

    const counter = metrics.registry.getSingleMetric('http_requests_total');
    const snapshot = await (
      counter as {
        get: () => Promise<{
          values: { value: number; labels: Record<string, string> }[];
        }>;
      }
    ).get();
    const series = snapshot.values.find(
      (v) =>
        v.labels.route === '/api/v1/trace' && v.labels.status_code === '201',
    );
    expect(series?.value).toBe(2);
  });

  it('includes default process metrics when enabled', async () => {
    const metrics = createMetrics({ collectDefault: true });
    const text = await metrics.registry.metrics();
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});
