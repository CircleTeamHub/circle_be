import { LoggerService } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import {
  resolveRequestId,
  runWithRequestContext,
  setRequestUserId,
} from './request-context';

export interface RequestLoggerOptions {
  enabled: boolean;
  slowRequestMs: number;
}

function readPath(req: Request): string {
  const rawPath = req.originalUrl || req.url || '';
  return rawPath.split('?')[0] || '/';
}

function readIp(req: Request): string | undefined {
  return (
    (req.headers['x-forwarded-for'] as string | undefined)
      ?.split(',')[0]
      ?.trim() ||
    req.ip ||
    req.socket?.remoteAddress
  );
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
    if (!options.enabled) {
      return next();
    }

    const requestId = resolveRequestId(req.headers['x-request-id']);
    const path = readPath(req);
    const start = Date.now();
    res.setHeader('x-request-id', requestId);

    return runWithRequestContext(
      {
        requestId,
        traceId: requestId,
        method: req.method,
        path,
        ip: readIp(req),
        userAgent: readHeader(req.headers['user-agent']),
      },
      () => {
        res.on('finish', () => {
          const durationMs = Date.now() - start;
          const userId = readUserId(req);
          setRequestUserId(userId);

          const payload = {
            event: 'http_access',
            method: req.method,
            path,
            statusCode: res.statusCode,
            durationMs,
            requestId,
            traceId: requestId,
            userId,
            ip: readIp(req),
            userAgent: readHeader(req.headers['user-agent']),
            contentLength: res.getHeader('content-length'),
          };

          logger.log(payload, 'HttpAccess');

          if (durationMs >= options.slowRequestMs) {
            logger.warn(
              {
                ...payload,
                event: 'http_slow',
              },
              'HttpSlow',
            );
          }
        });

        next();
      },
    );
  };
}
