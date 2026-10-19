import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { catchError } from 'rxjs/operators';
import { PrismaService } from 'src/prisma/prisma.service';
import { diagnosticCause } from './diagnostic-context';
import { getRequestContext } from 'src/logging/request-context';
/** Failed authorized operator requests get a redacted receipt. No bodies, URLs, or error messages. */
@Injectable()
export class ConsoleDiagnosticsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ConsoleDiagnosticsInterceptor.name);
  constructor(private readonly prisma: PrismaService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(
      catchError(async (error: unknown) => {
        if (req.user?.role === 'ADMIN' && req.user?.audience === 'ADMIN') {
          const request = getRequestContext(),
            status = error instanceof HttpException ? error.getStatus() : 500;
          const route =
            typeof req.route?.path === 'string' &&
            /^\/[a-zA-Z0-9:/_-]+$/.test(req.route.path)
              ? req.route.path.slice(0, 180)
              : 'unknown';
          try {
            await this.prisma.adminAuditLog.create({
              data: {
                actorID: req.user.userId,
                action: 'console.request.failed',
                entityType: 'http_request',
                requestId: request?.requestId,
                metadata: {
                  status,
                  failureCause: diagnosticCause(error, status),
                  method: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(
                    req.method,
                  )
                    ? req.method
                    : 'OTHER',
                  route,
                },
              },
            });
          } catch {
            this.logger.warn(
              'Failed to persist operator diagnostic receipt; consult server logs using the request ID',
            );
          }
        }
        throw error;
      }),
    );
  }
}
