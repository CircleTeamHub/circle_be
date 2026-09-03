import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import type { ErrorAggregationProvider } from '../logging/error-aggregation.service';
import { markErrorCaptured, wasErrorCaptured } from '../logging/handled-errors';
import { getRequestContext } from '../logging/request-context';
import { resolvePrismaKnownErrorStatus } from './prisma-error-status';

type PrismaFilteredRequest = {
  method?: string;
  url?: string;
  user?: { userId?: string };
};

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('PrismaException');

  /**
   * Optional: unknown Prisma codes are 500s, and because this filter is more
   * specific than AllExceptionFilter it is the only one that sees them. Route
   * handler failures were already forwarded by ErrorLoggingInterceptor (marker
   * checked); guard-side failures are forwarded here.
   */
  constructor(private readonly errorAggregation?: ErrorAggregationProvider) {}

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<PrismaFilteredRequest>();

    const status =
      resolvePrismaKnownErrorStatus(exception.code) ??
      HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Database error';
    let extra: Record<string, unknown> | undefined;

    switch (exception.code) {
      case 'P2002': {
        // Do NOT leak the conflicting column(s) to the client: naming the unique
        // field (email / accountId / ...) turns any create/update into a
        // user-enumeration oracle (F-06). Log it server-side for ops, return a
        // generic message with no `conflict` payload.
        const target = (exception.meta as { target?: string[] } | undefined)
          ?.target;
        if (target?.length) {
          this.logger.warn(
            `Unique constraint conflict on [${target.join(', ')}] at ${request.method} ${request.url}`,
          );
        }
        message = 'Resource already exists';
        break;
      }
      case 'P2025':
        message = 'Resource not found';
        break;
      case 'P2003':
        message = 'Invalid reference';
        break;
      default:
        // Unknown Prisma error — keep generic message to client but log
        // full context so operators can correlate.
        this.logger.error(
          `Unhandled Prisma error ${exception.code} at ${request.method} ${request.url}`,
          {
            code: exception.code,
            meta: exception.meta,
            message: exception.message,
          },
        );
        this.captureServerError(exception, status, request);
        break;
    }

    response.status(status).json({
      code: status,
      message,
      data: extra ?? null,
    });
  }

  private captureServerError(
    exception: Prisma.PrismaClientKnownRequestError,
    status: number,
    request: PrismaFilteredRequest,
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
        path: requestContext?.path ?? request.url?.split('?')[0],
        userId: requestContext?.userId ?? request.user?.userId,
      });
      markErrorCaptured(exception);
    } catch (aggregationError) {
      this.logger.error(
        `error aggregation failed for Prisma error ${exception.code}: ${
          aggregationError instanceof Error
            ? aggregationError.message
            : String(aggregationError)
        }`,
      );
    }
  }
}
