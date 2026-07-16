import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('PrismaException');

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<{ method?: string; url?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Database error';
    let extra: Record<string, unknown> | undefined;

    switch (exception.code) {
      case 'P2002': {
        status = HttpStatus.CONFLICT;
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
        status = HttpStatus.NOT_FOUND;
        message = 'Resource not found';
        break;
      case 'P2003':
        status = HttpStatus.BAD_REQUEST;
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
        break;
    }

    response.status(status).json({
      code: status,
      message,
      data: extra ?? null,
    });
  }
}
