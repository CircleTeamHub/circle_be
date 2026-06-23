import { LoggerService } from '@nestjs/common';
import { Request, Response } from 'express';
import { getRequestContext } from './request-context';
import { logSecurityEvent } from './security-event.logger';

interface RateLimitLoggerOptions {
  enabled: boolean;
  securityLogOn: boolean;
  limiterName: string;
  message?: unknown;
}

function readPath(req: Request): string {
  const rawPath = req.originalUrl || req.url || '';
  return rawPath.split('?')[0] || '/';
}

function readUserId(req: Request): string | undefined {
  const user = (req as Request & { user?: { userId?: string; id?: string } })
    .user;
  return user?.userId || user?.id;
}

function defaultMessage(message: unknown): unknown {
  return message ?? { message: 'Too many requests, please try again later.' };
}

export function createRateLimitHandler(
  logger: LoggerService,
  options: RateLimitLoggerOptions,
) {
  return (
    req: Request,
    res: Response,
    _next?: unknown,
    rateLimitOptions?: { statusCode?: number; message?: unknown },
  ) => {
    const requestContext = getRequestContext();
    const statusCode = rateLimitOptions?.statusCode ?? 429;
    const responseMessage = defaultMessage(
      options.message ?? rateLimitOptions?.message,
    );

    if (options.enabled) {
      logger.warn(
        {
          event: 'rate_limit_hit',
          limiterName: options.limiterName,
          method: req.method,
          path: readPath(req),
          statusCode,
          requestId: requestContext?.requestId,
          traceId: requestContext?.traceId,
          userId: readUserId(req),
          ip: req.ip || req.socket?.remoteAddress,
        },
        'RateLimit',
      );
    }

    logSecurityEvent(logger, {
      enabled: options.securityLogOn,
      securityEvent: 'rate_limit_hit',
      statusCode,
      userId: readUserId(req),
      metadata: { limiterName: options.limiterName },
    });

    return res.status(statusCode).json(responseMessage);
  };
}
