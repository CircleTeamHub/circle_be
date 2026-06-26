import type { Request, Response, NextFunction } from 'express';
import { normalizeRoute, limitRouteCardinality } from './route-normalizer';
import type { Metrics } from './metrics.service';

/** The scrape endpoint records nothing about itself (avoids self-referential noise). */
const METRICS_PATH = '/metrics';

/**
 * Express middleware that records RED metrics (request count + duration) for
 * every request once the response finishes. Routes are normalized to keep
 * cardinality bounded. Add this early so the timer spans the whole request.
 */
export function createHttpMetricsMiddleware(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === METRICS_PATH) {
      next();
      return;
    }

    const startNs = process.hrtime.bigint();
    res.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      metrics.recordHttpRequest({
        method: req.method,
        route: limitRouteCardinality(normalizeRoute(req.path)),
        statusCode: res.statusCode,
        durationSeconds,
      });
    });

    next();
  };
}
