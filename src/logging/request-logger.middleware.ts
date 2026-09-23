import { LoggerService } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { performance } from 'node:perf_hooks';
import { resolveRequestId, runWithRequestContext } from './request-context';
import { safeLogPath } from './log-sanitizer';
import { attemptDiagnostic } from './http-failure.logger';

export interface RequestLoggerOptions {
  enabled: boolean;
  slowRequestMs: number;
}

function readUserId(req: Request): string | undefined {
  const user = (req as Request & { user?: { userId?: string; id?: string } })
    .user;
  return user?.userId || user?.id;
}

export function createRequestLoggerMiddleware(
  logger: LoggerService,
  options: RequestLoggerOptions,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    const path = safeLogPath(req.originalUrl || req.url || '');
    const start = performance.now();
    const userAgent = req.headers['user-agent'];
    const context = {
      requestId,
      traceId: requestId,
      method: req.method,
      path,
      // Retained only in request-local context for dedicated audit consumers.
      // Express applies the configured trust-proxy policy to req.ip.
      ip: req.ip || req.socket?.remoteAddress,
      userAgent:
        typeof userAgent === 'string' ? userAgent.slice(0, 512) : undefined,
      userId: readUserId(req),
    };
    res.setHeader('x-request-id', requestId);
    return runWithRequestContext(context, () => {
      if (options.enabled) {
        let recorded = false;
        const complete = (aborted: boolean) => {
          if (recorded) return;
          recorded = true;
          res.removeListener('finish', finished);
          res.removeListener('close', closed);
          const durationMs =
            Math.round((performance.now() - start) * 100) / 100;
          context.userId = readUserId(req) ?? context.userId;
          const payload = {
            event: aborted ? 'http_aborted' : 'http_access',
            method: req.method,
            path,
            statusCode: res.statusCode,
            durationMs,
            requestId,
            traceId: requestId,
            userId: context.userId,
            aborted,
          };
          runWithRequestContext(context, () => {
            attemptDiagnostic(() =>
              aborted
                ? logger.warn(payload, 'HttpAccess')
                : logger.log(payload, 'HttpAccess'),
            );
            if (!aborted && durationMs >= options.slowRequestMs) {
              attemptDiagnostic(() =>
                logger.warn({ ...payload, event: 'http_slow' }, 'HttpSlow'),
              );
            }
          });
        };
        const finished = () => complete(false);
        const closed = () => complete(!res.writableFinished);
        res.once('finish', finished);
        res.once('close', closed);
      }
      // Context/correlation remain available with access log output disabled.
      next();
    });
  };
}
