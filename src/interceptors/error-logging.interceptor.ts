import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  LoggerService,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { getRequestContext } from '../logging/request-context';

@Injectable()
export class ErrorLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
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

        return throwError(() => error);
      }),
    );
  }
}
