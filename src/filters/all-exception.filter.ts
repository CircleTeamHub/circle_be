import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  LoggerService,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import * as requestIp from 'request-ip';
import type { ErrorAggregationProvider } from '../logging/error-aggregation.service';
import {
  markErrorCaptured,
  markSecurityEventLogged,
  wasErrorCaptured,
  wasSecurityEventLogged,
} from '../logging/handled-errors';
import { createLoggingConfig } from '../logging/logging.config';
import { getRequestContext } from '../logging/request-context';
import { logSecurityEvent } from '../logging/security-event.logger';

const REDACTED_KEYS = new Set([
  'password',
  'newpassword',
  'oldpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'cookie',
  'set-cookie',
  'secret',
  'apikey',
  'api_key',
  'x-api-key',
  'sessionid',
]);

const MAX_DEPTH = 4;

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase())
        ? '[REDACTED]'
        : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function statusCodeName(status: number): string {
  return HttpStatus[status] ?? 'UNKNOWN';
}

function initialErrorMessage(
  isProduction: boolean,
  exception: unknown,
): string {
  if (isProduction) {
    return 'Internal server error';
  }
  if (exception instanceof Error) {
    return exception.message;
  }
  return 'Internal server error';
}

function responseMessage(
  body: Record<string, unknown>,
  fallback: string,
): string {
  if (typeof body.message === 'string') {
    return body.message;
  }
  if (Array.isArray(body.message)) {
    return (body.message as unknown[]).join('; ');
  }
  return fallback;
}

function exceptionCause(exception: unknown, status: number): unknown {
  if (status < 500) {
    return undefined;
  }
  return exception instanceof Error ? exception.stack : exception;
}

function readPathWithoutQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.split('?')[0] || '/';
}

type FilteredRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  query?: unknown;
  user?: { userId?: string };
};

@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  private readonly isProduction = process.env.NODE_ENV === 'production';
  private readonly loggingConfig = createLoggingConfig();

  /**
   * `errorAggregation` is optional so the filter keeps working in tests and in
   * builds that never wire Sentry. When present it is the last line of
   * defence for failures ErrorLoggingInterceptor cannot see (guards, pipes,
   * middleware); handler failures the interceptor already forwarded are
   * skipped via the handled-errors markers.
   */
  constructor(
    private readonly logger: LoggerService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly errorAggregation?: ErrorAggregationProvider,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FilteredRequest>();
    const response = ctx.getResponse();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message: string = initialErrorMessage(this.isProduction, exception);
    // 稳定错误码(如 AUTH_INVALID_CREDENTIALS):由 `throw new X({ message, errorCode })`
    // 携带,透传给前端做多语言映射。message 仍是人类可读兜底。
    let errorCode: string | undefined;
    // 结构化补充数据(如「非本圈成员」错误带上 circleId/circleName 供前端「申请加入」)。
    // 由 `throw new X({ message, errorCode, details })` 携带，透传进 envelope 的 data。
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = statusCodeName(status);
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        message = responseMessage(b, message);
        if (typeof b.code === 'string') code = b.code;
        if (typeof b.errorCode === 'string') errorCode = b.errorCode;
        if (b.details !== undefined && b.details !== null) details = b.details;
      }
    }

    const logPayload = {
      method: request.method,
      path: request.url,
      status,
      code,
      userId: request.user?.userId,
      ip: requestIp.getClientIp(request as never),
      query: scrub(request.query),
      // Body intentionally omitted by default to avoid leaking PII / secrets;
      // turn on per-route via dedicated middleware if a debug capture is needed.
      cause: exceptionCause(exception, status),
    };

    if (status >= 500) {
      this.logger.error(message, logPayload);
      this.captureServerError(exception, status, request);
    } else {
      this.logger.warn(message, logPayload);
    }

    if (status === 401 || status === 403) {
      this.logSecurityRejection(exception, status, message, request);
    }

    const responseBody = {
      code: status,
      message,
      data: details ?? null,
      ...(errorCode ? { errorCode } : {}),
    };

    httpAdapter.reply(response, responseBody, status);
  }

  /**
   * Guards / pipes / middleware throw before any interceptor runs, so a
   * database outage surfacing inside JwtStrategy or a throwing pipe would
   * otherwise be a 500 that never reaches Sentry. Same sanitized tag set as
   * the interceptor; never the body or headers.
   */
  private captureServerError(
    exception: unknown,
    status: number,
    request: FilteredRequest,
  ): void {
    if (!this.errorAggregation || wasErrorCaptured(exception)) {
      return;
    }
    const requestContext = getRequestContext();
    try {
      this.errorAggregation.captureError(exception, {
        statusCode: status,
        requestId: requestContext?.requestId,
        traceId: requestContext?.traceId,
        method: requestContext?.method ?? request.method,
        path: requestContext?.path ?? readPathWithoutQuery(request.url),
        userId: requestContext?.userId ?? request.user?.userId,
      });
      markErrorCaptured(exception);
    } catch (aggregationError) {
      this.logger.error(
        {
          event: 'error_aggregation_failed',
          requestId: requestContext?.requestId,
          message:
            aggregationError instanceof Error
              ? aggregationError.message
              : String(aggregationError),
        },
        'HttpError',
      );
    }
  }

  /**
   * 401/403 raised by guards (revoked session, wrong audience, missing role)
   * are the security signals that matter most and the interceptor never sees
   * them. Handler-raised ones were already logged there — skip those.
   */
  private logSecurityRejection(
    exception: unknown,
    status: number,
    reason: string,
    request: FilteredRequest,
  ): void {
    if (wasSecurityEventLogged(exception)) {
      return;
    }
    logSecurityEvent(this.logger, {
      enabled: this.loggingConfig.securityLogOn,
      securityEvent: status === 401 ? 'auth_unauthorized' : 'access_forbidden',
      statusCode: status,
      reason,
      userId: request.user?.userId,
    });
    markSecurityEventLogged(exception);
  }
}
