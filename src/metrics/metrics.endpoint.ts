import type { Request, Response } from 'express';
import type { Metrics } from './metrics.service';

/**
 * Express handler serving the Prometheus exposition format as raw text. Mounted
 * directly via `app.use('/metrics', ...)` so it bypasses the global `api/v1`
 * prefix and the JSON response interceptor.
 */
export function createMetricsHandler(metrics: Metrics) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      res.setHeader('Content-Type', metrics.registry.contentType);
      res.end(await metrics.registry.metrics());
    } catch {
      res.status(500).end('# failed to collect metrics\n');
    }
  };
}
