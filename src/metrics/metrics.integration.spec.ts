import express from 'express';
import request from 'supertest';
import { createMetrics } from './metrics.service';
import { createHttpMetricsMiddleware } from './http-metrics.middleware';
import { createMetricsHandler } from './metrics.endpoint';

function buildApp() {
  const metrics = createMetrics({ collectDefault: false });
  const app = express();
  app.use(createHttpMetricsMiddleware(metrics));
  app.use('/metrics', createMetricsHandler(metrics.registry));
  app.get('/api/v1/circle/:id', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get('/api/v1/boom', (_req, res) => {
    res.status(500).json({ error: true });
  });
  return app;
}

describe('metrics endpoint (integration)', () => {
  it('serves the Prometheus exposition format at /metrics', async () => {
    const res = await request(buildApp()).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('http_requests_total');
  });

  it('records a normalized route and status after a real request', async () => {
    const app = buildApp();

    await request(app).get(
      '/api/v1/circle/3fa85f64-5717-4562-b3fc-2c963f66afa6',
    );
    const res = await request(app).get('/metrics');

    expect(res.text).toContain('route="/api/v1/circle/:id"');
    expect(res.text).toContain('status_code="200"');
    expect(res.text).toMatch(/http_request_duration_seconds_bucket/);
  });

  it('captures 5xx responses', async () => {
    const app = buildApp();

    await request(app).get('/api/v1/boom');
    const res = await request(app).get('/metrics');

    expect(res.text).toContain('status_code="500"');
  });

  it('does not create a time series for the /metrics endpoint itself', async () => {
    const app = buildApp();

    await request(app).get('/metrics');
    const res = await request(app).get('/metrics');

    expect(res.text).not.toContain('route="/metrics"');
  });
});
