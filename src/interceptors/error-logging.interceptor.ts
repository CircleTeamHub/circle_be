import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  LoggerService,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { createLoggingConfig } from 'src/logging/logging.config';
import { getRequestContext } from '../logging/request-context';
import { logSecurityEvent } from '../logging/security-event.logger';
import type { ErrorAggregationProvider } from '../logging/error-aggregation.service';

/** Status codes at or above this are unexpected server errors worth aggregating. */
const SERVER_ERROR_THRESHOLD = 500;

@Injectable()
export class ErrorLoggingInterceptor implements NestInterceptor {
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    private readonly logger: LoggerService,
    private readonly errorAggregation?: ErrorAggregationProvider,
  ) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const requestContext = getRequestContext();
        const statusCode =
          error instanceof HttpException ? error.getStatus() : 500;
        const errorObject = error instanceof Error ? error : undefined;

        this.logger.error(
          {
            event: 'http_error',
            requestId: requestContext?.requestId,
            traceId: requestContext?.traceId,
            method: requestContext?.method,
            path: requestContext?.path,
            userId: requestContext?.userId,
            statusCode,
            errorName: errorObject?.name ?? 'UnknownError',
            message: errorObject?.message ?? String(error),
            stack: errorObject?.stack,
          },
          errorObject?.stack,
          'HttpError',
        );

        if (statusCode === 401 || statusCode === 403) {
          logSecurityEvent(this.logger, {
            enabled: this.loggingConfig.securityLogOn,
            securityEvent:
              statusCode === 401 ? 'auth_unauthorized' : 'access_forbidden',
            statusCode,
            reason: errorObject?.message ?? String(error),
          });
        }

        // Forward only unexpected server errors to optional aggregation
        // (Sentry). Expected 4xx client errors are never sent.
        if (statusCode >= SERVER_ERROR_THRESHOLD) {
          this.errorAggregation?.captureError(error, {
            statusCode,
            requestId: requestContext?.requestId,
            traceId: requestContext?.traceId,
            method: requestContext?.method,
            path: requestContext?.path,
            userId: requestContext?.userId,
          });
        }

        return throwError(() => error);
      }),
    );
  }
}
