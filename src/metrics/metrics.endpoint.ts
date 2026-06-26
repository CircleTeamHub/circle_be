import type { Request, Response } from 'express';
import type { Registry } from 'prom-client';

/**
 * Express handler serving the Prometheus exposition format as raw text. Mounted
 * directly via `app.use('/metrics', ...)` so it bypasses the global `api/v1`
 * prefix and the JSON response interceptor. Takes a registry directly so callers
 * can pass a merged registry (HTTP RED + business metrics).
 */
export function createMetricsHandler(
  registry: Pick<Registry, 'contentType' | 'metrics'>,
) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } catch {
      res.status(500).end('# failed to collect metrics\n');
    }
  };
}
