import {
  CallHandler,
  ExecutionContext,
  Injectable,
  LoggerService,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { createLoggingConfig } from 'src/logging/logging.config';
import { resolveErrorStatusCode } from '../filters/prisma-error-status';
import {
  getAuthFailureReason,
  isRoutineAuthFailure,
  markErrorCaptured,
  markSecurityEventLogged,
} from '../logging/handled-errors';
import { getRequestContext } from '../logging/request-context';
import { logSecurityEvent } from '../logging/security-event.logger';
import {
  attemptDiagnostic,
  logHttpFailure,
} from '../logging/http-failure.logger';
import type { ErrorAggregationProvider } from '../logging/error-aggregation.service';

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
        // Known Prisma failures have the same classification as their filter.
        const statusCode = resolveErrorStatusCode(error);
        logHttpFailure(this.logger, error, statusCode);
        if (
          (statusCode === 401 || statusCode === 403) &&
          !isRoutineAuthFailure(error)
        ) {
          attemptDiagnostic(
            () => {
              logSecurityEvent(this.logger, {
                enabled: this.loggingConfig.securityLogOn,
                securityEvent:
                  statusCode === 401 ? 'auth_unauthorized' : 'access_forbidden',
                statusCode,
                reason:
                  getAuthFailureReason(error) ??
                  (statusCode === 401 ? 'unauthorized' : 'forbidden'),
              });
              markSecurityEventLogged(error);
            },
            () =>
              this.logger.error(
                {
                  event: 'security_event_log_failed',
                  requestId: getRequestContext()?.requestId,
                },
                'HttpError',
              ),
          );
        }
        // Diagnostics may fail independently; always rethrow the original error.
        if (statusCode >= 500 && this.errorAggregation) {
          attemptDiagnostic(
            () => {
              this.errorAggregation!.captureError(error, {
                statusCode,
                requestId: requestContext?.requestId,
                traceId: requestContext?.traceId,
                method: requestContext?.method,
                path: requestContext?.path,
                userId: requestContext?.userId,
              });
              markErrorCaptured(error);
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
        return throwError(() => error);
      }),
    );
  }
}
