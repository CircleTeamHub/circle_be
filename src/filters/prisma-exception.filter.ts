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
import {
  attemptDiagnostic,
  logHttpFailure,
} from '../logging/http-failure.logger';
import { safeLogPath } from '../logging/log-sanitizer';
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

    switch (exception.code) {
      case 'P2002': {
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
        this.captureServerError(exception, status, request);
        break;
    }

    logHttpFailure(this.logger, exception, status, request);
    response.status(status).json({
      code: status,
      message,
      data: null,
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
    attemptDiagnostic(
      () => {
        this.errorAggregation!.captureError(exception, {
          statusCode: status,
          requestId: requestContext?.requestId,
          traceId: requestContext?.traceId,
          method: requestContext?.method ?? request.method,
          path: safeLogPath(requestContext?.path ?? request.url ?? ''),
          userId: requestContext?.userId ?? request.user?.userId,
        });
        markErrorCaptured(exception);
      },
      () =>
        this.logger.error(
          {
            event: 'error_aggregation_failed',
            requestId: getRequestContext()?.requestId,
          },
          'HttpError',
        ),
    );
  }
}
