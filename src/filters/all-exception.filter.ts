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

@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  private readonly isProduction = process.env.NODE_ENV === 'production';

  constructor(
    private readonly logger: LoggerService,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{
      method?: string;
      url?: string;
      headers?: Record<string, unknown>;
      body?: unknown;
      query?: unknown;
      user?: { userId?: string };
    }>();
    const response = ctx.getResponse();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message: string = initialErrorMessage(this.isProduction, exception);
    // 稳定错误码(如 AUTH_INVALID_CREDENTIALS):由 `throw new X({ message, errorCode })`
    // 携带,透传给前端做多语言映射。message 仍是人类可读兜底。
    let errorCode: string | undefined;

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
    } else {
      this.logger.warn(message, logPayload);
    }

    const responseBody = {
      code: status,
      message,
      data: null,
      ...(errorCode ? { errorCode } : {}),
    };

    httpAdapter.reply(response, responseBody, status);
  }
}
