import { timingSafeEqual } from 'crypto';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Registry } from 'prom-client';

const logger = new Logger('MetricsEndpoint');

export interface MetricsHandlerOptions {
  /**
   * When set, `/metrics` requires `Authorization: Bearer <authToken>`. Leave
   * undefined to keep the endpoint open (e.g. when it is only reachable from an
   * internal network / scrape sidecar). Compared in constant time.
   */
  authToken?: string;
}

/** Constant-time string compare that tolerates length mismatch without leaking it. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function extractBearer(header: unknown): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) {
    return undefined;
  }
  const token = value.slice('Bearer '.length).trim();
  return token === '' ? undefined : token;
}

/**
 * Express handler serving the Prometheus exposition format as raw text. Mounted
 * directly via `app.use('/metrics', ...)` so it bypasses the global `api/v1`
 * prefix and the JSON response interceptor. Takes a registry directly so callers
 * can pass a merged registry (HTTP RED + business metrics).
 *
 * Optionally gated by a bearer token (`options.authToken`): the exposition
 * format leaks the full route inventory, business-event rates and process
 * stats, so on a publicly reachable port it should not be served anonymously.
 */
export function createMetricsHandler(
  registry: Pick<Registry, 'contentType' | 'metrics'>,
  options: MetricsHandlerOptions = {},
) {
  const { authToken } = options;
  return async (req: Request, res: Response): Promise<void> => {
    if (authToken) {
      const provided = extractBearer(req.headers.authorization);
      if (!provided || !safeEqual(provided, authToken)) {
        res.status(401).end('# unauthorized\n');
        return;
      }
    }

    try {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      // A broken collector should be visible, not silently 500 — Prometheus
      // only sees a scrape failure, not the cause.
      logger.error(
        'Failed to collect Prometheus metrics',
        error instanceof Error ? error.stack : String(error),
      );
      res.status(500).end('# failed to collect metrics\n');
    }
  };
}
